require_relative 'crumbtrail/body'
require_relative 'crumbtrail/sender'

module Crumbtrail
  VERSION = '0.1.0'
  class Context
    attr_reader :session_id, :request_id
    def initialize(session_id, request_id, sink)
      @session_id, @request_id, @sink = session_id, request_id, sink
      @events = []
      @dropped = 0
      @sequence = 0
    end
    def add(kind, data, time = (Time.now.to_f * 1000).to_i)
      if @events.size < 200 || %w[backend.req.start backend.req.end backend.req.error].include?(kind)
        @events << { t: time, k: kind, d: data.merge(requestId: @request_id, sessionId: @session_id) }
      else
        @dropped += 1
      end
    end
    def database(kind, data)
      @sequence += 1
      add(kind, data.merge(seq: @sequence, t: (Time.now.to_f * 1000).to_i))
    end
    def flush
      if @dropped > 0
        @events << { t: (Time.now.to_f * 1000).to_i, k: 'capture_gap', d: { kind: 'capture_gap', surface: 'backend_request', reason: 'scan_budget_exceeded', requestId: @request_id, droppedEvents: @dropped } }
      end
      @events.sort_by! { |event| [event[:t], event[:k] == 'backend.req.start' ? 0 : 1] }
      @events.each_slice(20) { |events| @sink.enqueue(sessionId: @session_id, events: events) }
    rescue StandardError
      nil
    ensure
      @events.clear
    end
  end

  def self.current
    Thread.current[:crumbtrail_context]
  end
  def self.with_context(context)
    previous = current
    Thread.current[:crumbtrail_context] = context
    yield
  ensure
    Thread.current[:crumbtrail_context] = previous
  end

  class Input
    attr_reader :bytes, :truncated
    def initialize(io)
      @io, @bytes, @truncated = io, ''.b, false
    end
    def keep(data)
      return data unless data
      remaining = Body::LIMIT - @bytes.bytesize
      @bytes << data.b.byteslice(0, remaining)
      @truncated ||= data.bytesize > remaining
      data
    end
    def read(*args)
      keep(@io.read(*args))
    end
    def gets(*args)
      keep(@io.gets(*args))
    end
    def each
      return enum_for(:each) unless block_given?
      @io.each { |data| yield keep(data) }
    end
    def rewind
      result = @io.rewind
      @bytes.clear
      @truncated = false
      result
    end
  end

  class ResponseBody
    def initialize(body, context, finish)
      @body, @context, @finish = body, context, finish
      @bytes, @truncated, @finished = ''.b, false, false
    end
    def each
      return enum_for(:each) unless block_given?
      Crumbtrail.with_context(@context) do
        begin
          @body.each do |chunk|
            remaining = Body::LIMIT - @bytes.bytesize
            @bytes << chunk.b.byteslice(0, remaining)
            @truncated ||= chunk.bytesize > remaining
            yield chunk
          end
        rescue Exception => error
          finish(error)
          raise
        ensure
          finish
        end
      end
    end
    def close
      @body.close if @body.respond_to?(:close)
    ensure
      finish
    end
    private
    def finish(error = nil)
      return if @finished
      @finished = true
      @finish.call(@bytes, @truncated, error)
    rescue StandardError
      nil
    end
  end

  class Middleware
    ID = /\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\z/
    def initialize(app, sink:, service:, routes: nil)
      @app, @sink, @service, @routes = app, sink, service, routes
    end
    def call(env)
      eligible = begin
        @routes && @routes.call(env) && !env['rack.hijack?'] && ID.match?(env['HTTP_X_CRUMBTRAIL_SESSION_ID'].to_s) && ID.match?(env['HTTP_X_CRUMBTRAIL_REQUEST_ID'].to_s)
      rescue StandardError
        false
      end
      return @app.call(env) unless eligible
      context = Context.new(env['HTTP_X_CRUMBTRAIL_SESSION_ID'], env['HTTP_X_CRUMBTRAIL_REQUEST_ID'], @sink)
      original = env['rack.input']
      input = Input.new(original) if original && Body.json?(env['CONTENT_TYPE'])
      env['rack.input'] = input if input
      started, started_at = Process.clock_gettime(Process::CLOCK_MONOTONIC), (Time.now.to_f * 1000).to_i
      base = { method: env['REQUEST_METHOD'], url: env['PATH_INFO'], route: env['PATH_INFO'], pathname: env['PATH_INFO'], service: @service,
               correlation: { status: 'linked', sessionIdSource: 'header', requestIdSource: 'header' } }
      status, headers, body = nil
      finish = lambda do |bytes, truncated, error|
        request_body, request_state = input ? Body.capture(input.bytes, input.truncated) : [nil, 'missing']
        response_body, response_state = Body.json?(headers && (headers['content-type'] || headers['Content-Type'])) ? Body.capture(bytes, truncated) : [nil, 'missing']
        context.add('backend.req.start', base.merge(body: request_body, requestBodyState: request_state, redaction: Body.metadata('body', request_state)), started_at)
        context.add('backend.req.error', base.merge(error: { name: error.class.name })) if error
        context.add('backend.req.end', base.merge(statusCode: status || 500, durationMs: (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000,
          responseBody: response_body, responseBodyState: response_state, responseBodyTruncated: truncated, redaction: Body.metadata('responseBody', response_state)))
        context.flush
      ensure
        env['rack.input'] = original
      end
      begin
        status, headers, body = Crumbtrail.with_context(context) { @app.call(env) }
      rescue Exception => error
        begin
          finish.call('', false, error)
        rescue StandardError
          nil
        end
        raise
      end
      [status, headers, ResponseBody.new(body, context, finish)]
    end
  end
end
