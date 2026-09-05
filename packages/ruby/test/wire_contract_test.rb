require 'minitest/autorun'
require 'json'
require 'rack/mock'
require 'crumbtrail'

# Conformance against `test-fixtures/wire-contract/`.
#
# The Swift, Kotlin, Dart and Go SDKs run the equivalent of this file against the same files.
# Changing a fixture therefore fails all of them at once, which is the only mechanism that
# reliably catches one SDK quietly renaming an envelope field.
#
# The fixtures are read from the repository root rather than copied in: a per SDK copy would
# hide exactly the cross language drift they exist to catch.
class WireContractTest < Minitest::Test
  ROOT = begin
    directory = File.expand_path(__dir__)
    directory = File.dirname(directory) until Dir.exist?(File.join(directory, 'test-fixtures/wire-contract')) || directory == '/'
    raise "wire contract fixtures not found from #{__dir__}" unless Dir.exist?(File.join(directory, 'test-fixtures/wire-contract'))
    File.join(directory, 'test-fixtures/wire-contract')
  end

  def test_fixtures_are_reachable
    # If the path arithmetic is wrong, every other test here would pass vacuously.
    fixture = JSON.parse(File.read(File.join(ROOT, 'events/net.json')))
    assert_equal 'net', fixture['k']
  end

  # Every shared event kind, serialized through this SDK's own envelope builder. The payload and
  # the sdk descriptor come from the fixture, because a backend SDK does not emit these kinds;
  # the envelope field names, their presence and their encoding are this SDK's own.
  Dir.glob(File.join(ROOT, 'events/*.json')).sort.each do |path|
    define_method("test_envelope_#{File.basename(path, '.json').tr('-', '_')}") do
      fixture = JSON.parse(File.read(path))
      assert_equal Crumbtrail::SCHEMA_VERSION, fixture['schemaVersion'], 'contract schema version moved'
      event = Crumbtrail.event(fixture['t'], fixture['k'], fixture['d'],
                               platform: fixture['platform'],
                               sdk: { name: fixture['sdk']['name'], version: fixture['sdk']['version'] },
                               capabilities: fixture['capabilities'], target: fixture['target'])
      assert_equal fixture, JSON.parse(JSON.generate(event)),
                   "does not match test-fixtures/wire-contract/events/#{File.basename(path)}"
    end
  end

  def test_transport_path
    transport = JSON.parse(File.read(File.join(ROOT, 'transport.json')))
    assert_equal transport['endpoints']['events']['path'], Crumbtrail::Sender::EVENTS_PATH
  end

  # The envelope this SDK actually produces, from a real Rack run rather than a fixture.
  def test_production_events_carry_the_envelope
    sink = Object.new
    sink.instance_variable_set(:@events, [])
    def sink.enqueue(batch)
      @events.concat(batch[:events])
      true
    end
    def sink.events = @events
    app = Crumbtrail::Middleware.new(->(_) { [200, {}, ['ok']] }, sink: sink, service: 'ruby-test', routes: ->(_) { true })
    env = Rack::MockRequest.env_for('/api/quote', method: 'POST', input: '{}', 'CONTENT_TYPE' => 'application/json').merge(
      'HTTP_X_CRUMBTRAIL_SESSION_ID' => 'wire-session', 'HTTP_X_CRUMBTRAIL_REQUEST_ID' => 'wire-request')
    _, _, body = app.call(env)
    body.each { |_| nil }
    body.close
    refute_empty sink.events
    sink.events.each do |event|
      assert_equal Crumbtrail::SCHEMA_VERSION, event[:schemaVersion], event[:k]
      assert_equal Crumbtrail::PLATFORM, event[:platform], event[:k]
      assert_equal 'crumbtrail-ruby', event[:sdk][:name]
      refute_empty event[:sdk][:version]
      # An absent field and an empty array are different claims on the ingest side.
      refute event.key?(:capabilities), "#{event[:k]} sends an empty capabilities array"
      refute event.key?(:target), "#{event[:k]} sends an empty target"
    end
  end
end
