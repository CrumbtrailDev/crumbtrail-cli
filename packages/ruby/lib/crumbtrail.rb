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
    attr_reader :bytes, :truncated, :complete
    def initialize(io)
      @io, @bytes, @truncated, @complete = io, ''.b, false, false
    end
    def keep(data)
      return data unless data
      remaining = Body::LIMIT - @bytes.bytesize
      @bytes << data.b.byteslice(0, remaining)
      @truncated ||= data.bytesize > remaining
      data
    end
    def read(*args)
      data = @io.read(*args)
      @complete = true if args.empty? || args[0].nil? || data.nil? || data.bytesize < args[0]
      keep(data)
    end
    def gets(*args)
      data = @io.gets(*args)
      @complete = true if data.nil?
      keep(data)
    end
    def each
      return enum_for(:each) unless block_given?
      @io.each { |data| yield keep(data) }
      @complete = true
    end
    def rewind
      result = @io.rewind
      @bytes.clear
      @truncated = false
      @complete = false
      result
    end
  end

  class ResponseBody
    def initialize(body, context, finish)
      @body, @context, @finish = body, context, finish
      @bytes, @truncated, @finished, @complete = ''.b, false, false, false
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
          @complete = true
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
      @truncated = true if (error || !@complete) && !@bytes.empty?
      return if @finished
      @finished = true
      @finish.call(@bytes, @truncated, error)
    rescue StandardError
      nil
    end
  end

  class CallableResponseBody
    def initialize(body, context, finish)
      @body, @context, @finish, @finished = body, context, finish, false
    end
    def call(stream)
      Crumbtrail.with_context(@context) do
        begin
          result = @body.call(stream)
        rescue Exception => error
          finish('', false, error)
          raise
        end
        finish('', false)
        result
      end
    end
    def close
      @body.close if @body.respond_to?(:close)
    ensure
      finish('', false)
    end
    private
    def finish(bytes, truncated, error = nil)
      return if @finished
      @finished = true
      @finish.call(bytes, truncated, error, false)
    rescue StandardError
      nil
    end
  end

  class Middleware
    ID = /\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\z/
    def initialize(app, sink:, service:, routes: nil, route: nil)
      @app, @sink, @service, @routes, @route = app, sink, service, routes, route
    end
    def call(env)
      eligible = begin
        @routes && @routes.call(env) && env['HTTP_UPGRADE'].to_s.empty? && ID.match?(env['HTTP_X_CRUMBTRAIL_SESSION_ID'].to_s) && ID.match?(env['HTTP_X_CRUMBTRAIL_REQUEST_ID'].to_s)
      rescue StandardError
        false
      end
      return @app.call(env) unless eligible
      context = Context.new(env['HTTP_X_CRUMBTRAIL_SESSION_ID'], env['HTTP_X_CRUMBTRAIL_REQUEST_ID'], @sink)
      original = env['rack.input']
      original_hijack = env['rack.hijack']
      hijacked = false
      if original_hijack.respond_to?(:call)
        env['rack.hijack'] = lambda do |*args, &block|
          result = original_hijack.call(*args, &block)
          hijacked = true
          result
        end
      end
      input = Input.new(original) if original && Body.json?(env['CONTENT_TYPE'])
      env['rack.input'] = input if input
      started, started_at = Process.clock_gettime(Process::CLOCK_MONOTONIC), (Time.now.to_f * 1000).to_i
      base = { method: env['REQUEST_METHOD'], url: '/', route: '/', pathname: '/', service: @service,
               correlation: { status: 'linked', sessionIdSource: 'header', requestIdSource: 'header' } }
      status, headers, body = nil
      finish = lambda do |bytes, truncated, error = nil, observed = true|
        template = begin
          value = @route&.call(env)
          value.is_a?(String) && value.bytesize <= 512 && value.match?(%r{\A/[a-zA-Z0-9_{}:.* /-]*\z}) ? value : '/'
        rescue StandardError
          '/'
        end
        base.merge!(url: template, route: template, pathname: template)
        length = env['CONTENT_LENGTH'].to_s
        complete = input && (length.match?(/\A[0-9]+\z/) ? input.bytes.bytesize == length.to_i : input.complete)
        request_body, request_state = input && !input.bytes.empty? ? Body.capture(input.bytes, input.truncated || !complete) : [nil, 'missing']
        body_allowed = env['REQUEST_METHOD'] != 'HEAD' && status != 204 && status != 304 && !(status && status < 200)
        content_length = (headers && (headers['content-length'] || headers['Content-Length'])).to_s
        if observed && body_allowed && content_length.match?(/\A[0-9]+\z/)
          truncated ||= bytes.bytesize != content_length.to_i
        end
        response_body, response_state = observed && body_allowed && Body.json?(headers && (headers['content-type'] || headers['Content-Type'])) ? Body.capture(bytes, truncated) : [nil, 'missing']
        context.add('backend.req.start', base.merge(body: request_body, requestBodyState: request_state, redaction: Body.metadata('body', request_state)), started_at)
        context.add('backend.req.error', base.merge(error: { name: error.class.name })) if error
        context.add('backend.req.end', base.merge(statusCode: status || 500, durationMs: (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000,
          responseBody: response_body, responseBodyState: response_state, responseBodyTruncated: truncated, redaction: Body.metadata('responseBody', response_state)))
        context.flush
      ensure
        env['rack.input'] = original
        env['rack.hijack'] = original_hijack if original_hijack
      end
      begin
        status, headers, body = Crumbtrail.with_context(context) { @app.call(env) }
      rescue Exception => error
        begin
          if hijacked
            env['rack.input'] = original
            env['rack.hijack'] = original_hijack if original_hijack
          else
            finish.call('', false, error)
          end
        rescue StandardError
          nil
        end
        raise
      end
      if hijacked || headers&.fetch('rack.hijack', nil)
        env['rack.input'] = original
        env['rack.hijack'] = original_hijack if original_hijack
        return [status, headers, body]
      end
      wrapper = body.respond_to?(:each) ? ResponseBody : CallableResponseBody
      [status, headers, wrapper.new(body, context, finish)]
    end
  end
end
