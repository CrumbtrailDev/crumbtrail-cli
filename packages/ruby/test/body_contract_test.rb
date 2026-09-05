require 'minitest/autorun'
require 'json'
require 'crumbtrail'

# Conformance against `test-fixtures/backend-body/cases.json`.
#
# The Go and ASP.NET Core packages run the same file. Reading it from the repository root
# rather than copying it in is the whole point: three hand written copies of this policy is
# how Ruby, Go and .NET ended up redacting the same body three different ways.
class BodyContractTest < Minitest::Test
  CORPUS = begin
    directory = File.expand_path(__dir__)
    directory = File.dirname(directory) until File.exist?(File.join(directory, 'test-fixtures/backend-body/cases.json')) || directory == '/'
    path = File.join(directory, 'test-fixtures/backend-body/cases.json')
    raise "backend body corpus not found from #{__dir__}" unless File.exist?(path)
    JSON.parse(File.read(path))
  end

  def test_corpus_is_reachable
    # Without this every other assertion here could pass vacuously.
    refute_empty CORPUS['cases']
    assert_equal Crumbtrail::Body::POLICY, CORPUS['policy']
  end

  def test_limits_match_the_corpus
    limits = CORPUS['limits']
    assert_equal limits['bytes'], Crumbtrail::Body::LIMIT
    assert_equal limits['nesting'], Crumbtrail::Body::MAX_NESTING
    assert_equal limits['keys'], Crumbtrail::Body::MAX_KEYS
    assert_equal limits['items'], Crumbtrail::Body::MAX_ITEMS
    assert_equal limits['integerDigits'], Crumbtrail::Body::MAX_INTEGER_DIGITS
    assert_equal limits['safeInteger'], Crumbtrail::Body::SAFE_INTEGER
  end

  CORPUS['cases'].each do |example|
    define_method("test_#{example['name']}") do
      body, state = Crumbtrail::Body.capture(example['input'].b)
      assert_equal example['state'], state, "#{example['name']}: #{example['why']}"
      if example['body'].nil?
        assert_nil body, "#{example['name']} should withhold the body entirely"
      else
        assert_equal example['body'], JSON.parse(body), "#{example['name']}: #{example['why']}"
      end
    end
  end
end
