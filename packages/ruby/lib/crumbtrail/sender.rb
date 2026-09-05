require 'net/http'
require 'uri'
require 'json'
require_relative 'event'

module Crumbtrail
  class Sender
    # 429 and 5xx are the only answers worth repeating the identical batch into. A 404 names a
    # session the cloud does not have, and every later batch for that id is refused the same
    # way, so retrying it four times only delays the gap that says the evidence is gone.
    RETRYABLE = [429].freeze
    # Shed reasons authored by the capture edge. An unrecognised reason is recorded as a plain
    # delivery failure rather than passed through as an invented classification.
    SHED_REASONS = %w[kill_switch sessions_per_hour bytes_per_day rate_limited_ingest
                      rate_limited_session_start trial_expired payment_failed upgrade_required].freeze
    EVENTS_PATH = '/api/events'.freeze
    ATTEMPTS = 4
    MAX_SHED_SECONDS = 300
    MAX_RESPONSE_BYTES = 4096

    def initialize(endpoint:, key:, cert_store: nil, logger: nil)
      @endpoint = URI(endpoint)
      raise ArgumentError, 'Crumbtrail requires HTTPS without credentials, query or fragment' unless @endpoint.is_a?(URI::HTTPS) && @endpoint.host && !@endpoint.userinfo && !@endpoint.query && !@endpoint.fragment
      raise ArgumentError, 'Crumbtrail ingest key is required' if key.to_s.strip.empty? || key.match?(/[[:cntrl:]]/)
      @key = key
      @cert_store = cert_store
      @logger = logger
      @queue = SizedQueue.new(64)
      @monitor = Mutex.new
      @wake = ConditionVariable.new
      @stopping = false
      @shed_until = nil
      @shed = nil
      @worker = Thread.new do
        while (batch = @queue.pop)
          begin
            deliver(batch[0], batch[1], batch[2])
          rescue Exception
            # A worker killed by anything other than a StandardError would leave `close` joining
            # a dead thread and reporting a clean drain over an empty queue.
            nil
          end
        end
      end
      @worker.report_on_exception = false
    end

    def enqueue(batch)
      session = (batch[:sessionId] || batch['sessionId']).to_s
      events = batch[:events] || batch['events'] || []
      @queue.push([session, JSON.generate(batch), events.size], true)
      true
    rescue ThreadError, ClosedQueueError, JSON::GeneratorError
      false
    end

    # Closing the queue allows queued batches to drain within the caller's deadline. Past the
    # deadline the worker is cancelled, so a retry backoff cannot hold process exit open past
    # the timeout the caller asked for.
    def close(timeout: 5)
      @queue.close
      return true if @worker.join(timeout)
      cancel
      @worker.join(1)
      false
    end

    private

    def cancel
      @monitor.synchronize do
        @stopping = true
        @wake.broadcast
      end
    end

    def stopping?
      @monitor.synchronize { @stopping }
    end

    # Interruptible backoff. `sleep` here blocks process exit for the whole retry budget.
    def pause(seconds)
      @monitor.synchronize do
        next if @stopping
        @wake.wait(@monitor, seconds)
      end
    end

    def deliver(session, payload, count, gap: false)
      return if stopping?
      if shedding?
        @shed[:dropped] += count unless gap
        return
      end
      flush_shed_gap unless gap
      ATTEMPTS.times do |attempt|
        return if stopping?
        response = begin
          post(payload)
        rescue StandardError
          nil # No response at all. A network failure is retried per the queue policy.
        end
        if response
          code = response.code.to_i
          if code == 202 && (directive = shed_directive(response))
            begin_shed(session, directive, count) unless gap
            return
          end
          return if code / 100 == 2
          unless RETRYABLE.include?(code) || code >= 500
            refuse(session, count, code) unless gap
            return
          end
        end
        break if attempt == ATTEMPTS - 1
        pause(0.25 * (attempt + 1))
      end
      refuse(session, count, nil) unless gap
    end

    def post(payload)
      uri = @endpoint.dup
      uri.path = EVENTS_PATH
      request = Net::HTTP::Post.new(uri)
      request['Authorization'] = "Bearer #{@key}"
      request['Content-Type'] = 'application/json'
      request.body = payload
      options = { use_ssl: true, open_timeout: 2, read_timeout: 3, write_timeout: 3 }
      options[:cert_store] = @cert_store if @cert_store
      Net::HTTP.start(uri.host, uri.port, **options) { |http| http.request(request) }
    end

    # A 202 passes any "is this a success" test while the cloud has already discarded the
    # evidence. Reading the body is the only way to tell the two apart.
    def shed_directive(response)
      body = response.body.to_s
      return nil if body.empty? || body.bytesize > MAX_RESPONSE_BYTES
      parsed = JSON.parse(body)
      return nil unless parsed.is_a?(Hash) && parsed['capture'] == 'shed'
      seconds = parsed['retryAfterSeconds']
      seconds = response['Retry-After'].to_i unless seconds.is_a?(Numeric)
      { reason: SHED_REASONS.include?(parsed['reason']) ? parsed['reason'] : 'delivery_failed',
        seconds: seconds.to_f.clamp(0, MAX_SHED_SECONDS) }
    rescue JSON::ParserError, TypeError
      nil
    end

    def begin_shed(session, directive, count)
      @shed = { session: session, reason: directive[:reason], dropped: count }
      @monitor.synchronize { @shed_until = Process.clock_gettime(Process::CLOCK_MONOTONIC) + directive[:seconds] }
      log("Crumbtrail capture is shed at the endpoint (#{directive[:reason]}); pausing delivery for #{directive[:seconds].round}s")
    end

    def shedding?
      deadline = @monitor.synchronize { @shed_until }
      !deadline.nil? && Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
    end

    # The gap for a shed window cannot be delivered during the window. It is held and sent on
    # the first batch after Retry-After has passed.
    def flush_shed_gap
      return if @shed.nil? || shedding?
      shed = @shed
      @shed = nil
      @monitor.synchronize { @shed_until = nil }
      send_gap(shed[:session], shed[:reason], shed[:dropped], 'capture shed by the endpoint')
    end

    def refuse(session, count, code)
      detail = code ? "HTTP #{code}" : 'retry budget exhausted'
      log("Crumbtrail refused #{count} captured event(s): #{detail}")
      send_gap(session, 'delivery_failed', count, detail)
    end

    def send_gap(session, reason, count, detail)
      return if session.to_s.empty? || count.to_i <= 0
      event = Crumbtrail.event(Crumbtrail.now, 'capture_gap',
                               { kind: 'capture_gap', surface: 'backend_request', reason: reason,
                                 sessionId: session, droppedEventCount: count, detail: detail })
      deliver(session, JSON.generate(sessionId: session, events: [event]), 1, gap: true)
    rescue StandardError
      nil
    end

    def log(message)
      @logger ? @logger.warn(message) : warn(message)
    rescue StandardError
      nil
    end
  end
end
