require 'minitest/autorun'
require 'json'
require 'crumbtrail'

# The delivery contract, driven through a stubbed transport rather than a socket.
#
# `test_real_tls_delivery_retries_and_drains` in capture_test.rb proves the real HTTPS path
# works. These tests prove what the sender decides once it has an answer, which is where the
# damage was: a 202 shed and a 401 both read as success, so a revoked key produced a working
# looking SDK and a permanently empty project.
class SenderProtocolTest < Minitest::Test
  Response = Struct.new(:code, :body, :headers) do
    def [](name) = (headers || {})[name]
  end

  class Logger
    attr_reader :messages
    def initialize = @messages = []
    def warn(message) = @messages << message
  end

  def build(*responses)
    logger = Logger.new
    sender = Crumbtrail::Sender.new(endpoint: 'https://ingest.example.com', key: 'test-key', logger: logger)
    posts = []
    queued = responses.dup
    sender.define_singleton_method(:post) do |payload|
      posts << JSON.parse(payload)
      queued.shift || Response.new('200', '', {})
    end
    [sender, posts, logger]
  end

  def batch(session, count)
    events = Array.new(count) { |index| Crumbtrail.event(index, 'backend.req.end', {}) }
    JSON.generate(sessionId: session, events: events)
  end

  # `deliver` is driven directly so the assertions do not race the worker thread.
  def deliver(sender, session, count)
    sender.send(:deliver, session, batch(session, count), count)
  end

  def gaps(posts)
    posts.flat_map { |post| post['events'] }.select { |event| event['k'] == 'capture_gap' }
  end

  def test_permanent_status_records_a_gap_and_logs
    sender, posts, logger = build(Response.new('401', '', {}))
    deliver(sender, 'session', 4)
    assert_equal 2, posts.size, 'a 401 was retried; the key is revoked, repeating cannot help'
    gap = gaps(posts).first
    refute_nil gap, 'a permanent refusal left no record that the evidence is gone'
    assert_equal 'delivery_failed', gap['d']['reason']
    assert_equal 4, gap['d']['droppedEventCount']
    assert_equal 'HTTP 401', gap['d']['detail']
    assert_includes logger.messages.first, 'HTTP 401'
  ensure
    sender&.close(timeout: 1)
  end

  def test_not_found_is_attempted_once
    sender, posts, = build(Response.new('404', '', {}))
    deliver(sender, 'session', 1)
    assert_equal 1, posts.count { |post| post['events'].none? { |event| event['k'] == 'capture_gap' } }
  ensure
    sender&.close(timeout: 1)
  end

  def test_retryable_status_is_repeated_then_accepted
    sender, posts, = build(Response.new('429', '', {}), Response.new('503', '', {}), Response.new('200', '', {}))
    deliver(sender, 'session', 2)
    assert_equal 3, posts.size
    assert_empty gaps(posts), 'a batch that was eventually accepted reported a hole'
  ensure
    sender&.close(timeout: 1)
  end

  # A 202 passes every "is this a success" test while the cloud has already discarded the batch.
  def test_shed_pauses_delivery_and_reports_the_whole_hole
    shed = Response.new('202', JSON.generate(capture: 'shed', reason: 'rate_limited_ingest', retryAfterSeconds: 0.05), {})
    sender, posts, logger = build(shed)
    deliver(sender, 'session', 3)
    assert_equal 1, posts.size
    assert_includes logger.messages.first, 'rate_limited_ingest'
    deliver(sender, 'session', 5)
    assert_equal 1, posts.size, 'delivery continued inside the Retry-After window'
    sleep 0.08
    deliver(sender, 'session', 1)
    assert_equal 3, posts.size, 'delivery did not resume after the Retry-After window'
    gap = gaps(posts).first
    assert_equal 'rate_limited_ingest', gap['d']['reason']
    assert_equal 8, gap['d']['droppedEventCount'], 'the shed batch and the suppressed batch are both lost'
  ensure
    sender&.close(timeout: 1)
  end

  def test_retry_after_header_is_honoured_without_a_body_field
    shed = Response.new('202', JSON.generate(capture: 'shed', reason: 'kill_switch'), { 'Retry-After' => '120' })
    sender, posts, = build(shed)
    deliver(sender, 'session', 1)
    deliver(sender, 'session', 1)
    assert_equal 1, posts.size, 'the Retry-After header was ignored'
  ensure
    sender&.close(timeout: 1)
  end

  # An unrecognised reason is a classification this SDK cannot vouch for.
  def test_unknown_shed_reason_is_recorded_as_a_plain_delivery_failure
    shed = Response.new('202', JSON.generate(capture: 'shed', reason: 'something_new', retryAfterSeconds: 0), {})
    sender, posts, = build(shed)
    deliver(sender, 'session', 2)
    deliver(sender, 'session', 1)
    assert_equal 'delivery_failed', gaps(posts).first['d']['reason']
  ensure
    sender&.close(timeout: 1)
  end

  # Without this the first refusal posts a gap, the gap is refused, and that posts a gap.
  def test_a_refused_gap_does_not_recurse
    sender, posts, = build(*Array.new(6) { Response.new('401', '', {}) })
    deliver(sender, 'session', 1)
    assert_equal 2, posts.size
  ensure
    sender&.close(timeout: 1)
  end

  def test_close_does_not_wait_out_the_retry_budget
    sender, = build(*Array.new(4) { Response.new('503', '', {}) })
    sender.enqueue(sessionId: 'session', events: [Crumbtrail.event(1, 'backend.req.end', {})])
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    sender.close(timeout: 0.1)
    assert_operator Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, :<, 1.2
  end
end
