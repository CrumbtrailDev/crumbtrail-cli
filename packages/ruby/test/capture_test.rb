require 'minitest/autorun'
require 'rack/mock'
require 'active_record'
require 'crumbtrail/active_record'
require 'stringio'

class CaptureTest < Minitest::Test
  class Sink
    attr_reader :batches
    def initialize; @batches = []; end
    def enqueue(batch); @batches << batch; end
    def events; @batches.flat_map { |batch| batch[:events] }; end
  end
  def setup
    @sink = Sink.new
  end
  def middleware(app, **options)
    Crumbtrail::Middleware.new(app, sink: @sink, service: 'ruby-test', routes: ->(_) { true }, **options)
  end
  def env(body = '{"amount":18.75,"entityId":731,"currency":"CAD","password":"never-send"}')
    Rack::MockRequest.env_for('/api/quote?secret=never-send', method: 'POST', input: body, 'CONTENT_TYPE' => 'application/json').merge(
      'HTTP_X_CRUMBTRAIL_SESSION_ID' => 'ruby-contract-session', 'HTTP_X_CRUMBTRAIL_REQUEST_ID' => 'ruby-contract-request')
  end
  def consume(response)
    status, headers, body = response
    bytes = ''.b
    body.each { |chunk| bytes << chunk }
    body.close if body.respond_to?(:close)
    [status, headers, bytes]
  end
  def test_real_rack_and_database_capture
    ActiveRecord::Base.establish_connection(adapter: 'sqlite3', database: ':memory:')
    Crumbtrail::ActiveRecord.install(engine: 'sqlite')
    input = nil
    app = middleware(lambda do |e|
      input = e['rack.input'].read
      ActiveRecord::Base.connection.execute('SELECT 731 AS operand')
      begin
        ActiveRecord::Base.connection.execute('SELECT * FROM absent_table')
      rescue ActiveRecord::StatementInvalid
        nil
      end
      [200, { 'content-type' => 'application/json' }, ['{"total":37.5,"currency":"CAD","password":"never-send"}']]
    end)
    response = Rack::MockRequest.new(app).post('/api/quote', input: '{"amount":18.75,"entityId":731,"currency":"CAD","password":"never-send"}', 'CONTENT_TYPE' => 'application/json',
      'HTTP_X_CRUMBTRAIL_SESSION_ID' => 'ruby-contract-session', 'HTTP_X_CRUMBTRAIL_REQUEST_ID' => 'ruby-contract-request')
    assert_equal 200, response.status
    assert_includes input, 'never-send'
    assert_includes response.body, 'never-send'
    assert_nil Crumbtrail.current
    start = @sink.events.find { |e| e[:k] == 'backend.req.start' }[:d]
    ending = @sink.events.find { |e| e[:k] == 'backend.req.end' }[:d]
    assert_equal 18.75, JSON.parse(start[:body])['amount']
    assert_equal 37.5, JSON.parse(ending[:responseBody])['total']
    assert_equal 'redacted', start[:requestBodyState]
    assert @sink.events.any? { |e| e[:k] == 'db.statement' && e[:d][:op] == 'select' }
    assert @sink.events.any? { |e| e[:k] == 'db.error' }
    refute_includes JSON.generate(@sink.batches), 'never-send'
    refute_includes JSON.generate(@sink.batches), 'absent_table'
    File.write(ENV['CRUMBTRAIL_CAPTURE_CONTRACT_OUTPUT'], JSON.generate({ sessionId: @sink.batches.first[:sessionId], events: @sink.events })) if ENV['CRUMBTRAIL_CAPTURE_CONTRACT_OUTPUT']
  ensure
    Crumbtrail::ActiveRecord.uninstall
    ActiveRecord::Base.connection_pool.disconnect!
  end
  def test_no_routes_or_bad_correlation_bypass
    app = ->(_) { [204, {}, []] }
    consume(middleware(app, routes: nil).call(env))
    consume(middleware(app).call(env.merge('HTTP_X_CRUMBTRAIL_REQUEST_ID' => "bad\n")))
    assert_empty @sink.events
  end
  def test_truncation_preserves_full_bytes_and_input_rewind
    large = '{"data":"' + 'a' * 20_000 + '"}'
    app = middleware(lambda do |e|
      assert_equal large, e['rack.input'].read
      e['rack.input'].rewind
      assert_equal large, e['rack.input'].read
      [200, { 'content-type' => 'application/problem+json' }, [large]]
    end)
    assert_equal large, consume(app.call(env(large)))[2]
    %w[backend.req.start backend.req.end].each do |kind|
      data = @sink.events.find { |e| e[:k] == kind }[:d]
      assert_equal 'truncated', data[kind.end_with?('start') ? :requestBodyState : :responseBodyState]
    end
  end
  def test_failure_rethrows_and_context_restores
    error = RuntimeError.new('secret-message')
    thrown = assert_raises(RuntimeError) { middleware(->(_) { raise error }).call(env) }
    assert_same error, thrown
    assert_nil Crumbtrail.current
    assert_equal 1, @sink.events.count { |e| e[:k] == 'backend.req.error' }
    refute_includes JSON.generate(@sink.batches), 'secret-message'
  end
  def test_stream_error_and_close_emit_once
    body = Object.new
    def body.each; yield '{'; raise IOError, 'private'; end
    def body.close; end
    response = middleware(->(_) { [200, { 'content-type' => 'application/json' }, body] }).call(env)
    assert_raises(IOError) { consume(response) }
    response[2].close
    assert_equal 1, @sink.events.count { |e| e[:k] == 'backend.req.end' }
    assert_equal 'invalid', @sink.events.last[:d][:responseBodyState]
    assert_equal 200, @sink.events.last[:d][:statusCode]
  end
  def test_broken_sink_preserves_response
    def @sink.enqueue(_); raise 'broken sink'; end
    assert_equal 'ok', consume(middleware(->(_) { [200, {}, ['ok']] }).call(env))[2]
  end
  def test_body_policy
    assert_equal 'invalid', Crumbtrail::Body.capture('{"a":1,"a":2}')[1]
    assert_equal 'invalid', Crumbtrail::Body.capture('{')[1]
    assert_equal 'missing', Crumbtrail::Body.capture('')[1]
    body, state = Crumbtrail::Body.capture('{"amount":18.75,"email":"x@example.com","routing_number":123,"note":"hello world","id":4111111111111111}')
    assert_equal 'redacted', state
    assert_equal 18.75, JSON.parse(body)['amount']
    assert_equal '[REDACTED]', JSON.parse(body)['routing_number']
    refute_includes body, '4111111111111111'
  end
  def test_deferred_body_reads_keep_request_tee
    request_env = env
    original = request_env['rack.input']
    app = middleware(lambda do |e|
      body = Enumerator.new do |out|
        refute_nil Crumbtrail.current
        assert_includes e['rack.input'].read, 'never-send'
        out << '{"total":37.5}'
      end
      [200, { 'content-type' => 'application/json' }, body]
    end)
    consume(app.call(request_env))
    assert_same original, request_env['rack.input']
    assert_equal 'redacted', @sink.events.find { |e| e[:k] == 'backend.req.start' }[:d][:requestBodyState]
  end
  def test_event_limit_keeps_request_boundaries
    app = middleware(lambda do |_|
      250.times { Crumbtrail.current.database('db.statement', { engine: 'sqlite', op: 'select' }) }
      [200, {}, ['ok']]
    end)
    consume(app.call(env))
    assert_equal 203, @sink.events.size
    assert @sink.events.any? { |e| e[:k] == 'backend.req.start' }
    assert @sink.events.any? { |e| e[:k] == 'backend.req.end' }
    assert_equal 50, @sink.events.find { |e| e[:k] == 'capture_gap' }[:d][:droppedEvents]
  end
  def test_sender_rejects_unsafe_endpoints
    %w[http://localhost https://user:pass@example.com https://example.com/?key=x].each do |endpoint|
      assert_raises(ArgumentError) { Crumbtrail::Sender.new(endpoint: endpoint, key: 'key') }
    end
  end
end

class SenderTest < Minitest::Test
  def test_real_tls_delivery_retries_and_drains
    require 'socket'
    require 'openssl'
    require 'tempfile'
    key = OpenSSL::PKey::RSA.new(2048)
    cert = OpenSSL::X509::Certificate.new
    cert.version = 2
    cert.serial = 1
    cert.subject = cert.issuer = OpenSSL::X509::Name.parse('/CN=localhost')
    cert.public_key = key.public_key
    cert.not_before = Time.now - 60
    cert.not_after = Time.now + 3600
    factory = OpenSSL::X509::ExtensionFactory.new
    factory.subject_certificate = factory.issuer_certificate = cert
    cert.add_extension(factory.create_extension('basicConstraints', 'CA:TRUE', true))
    cert.add_extension(factory.create_extension('subjectAltName', 'IP:127.0.0.1,DNS:localhost'))
    cert.sign(key, OpenSSL::Digest::SHA256.new)
    context = OpenSSL::SSL::SSLContext.new
    context.cert, context.key = cert, key
    tcp = TCPServer.new('127.0.0.1', 0)
    server = OpenSSL::SSL::SSLServer.new(tcp, context)
    requests = []
    worker = Thread.new do
      2.times do |index|
        socket = server.accept
        header = +''
        header << socket.gets until header.end_with?("\r\n\r\n")
        size = header[/Content-Length: (\d+)/i, 1].to_i
        requests << [header, socket.read(size)]
        code = index.zero? ? 404 : 200
        socket.write("HTTP/1.1 #{code} Result\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        socket.close
      end
    end
    store = OpenSSL::X509::Store.new
    store.add_cert(cert)
    Tempfile.create('crumbtrail-test-ca') do |file|
      file.write(cert.to_pem)
      file.flush
      sender = Crumbtrail::Sender.new(endpoint: "https://127.0.0.1:#{tcp.addr[1]}/prefix", key: 'test-key', cert_store: store)
      assert sender.enqueue(sessionId: 'session', events: [{ t: 1, k: 'backend.req.end', d: {} }])
      assert sender.close(timeout: 5)
      assert worker.join(1), 'TLS server did not receive both attempts'
      assert_equal 2, requests.size
      assert_includes requests.first[0], 'POST /api/events HTTP/1.1'
      assert_includes requests.first[0], 'Authorization: Bearer test-key'
      assert_equal 'session', JSON.parse(requests.first[1])['sessionId']
      refute sender.enqueue(sessionId: 'session', events: [])
    end
  ensure
    tcp&.close
    worker&.kill if worker&.alive?
  end
end
