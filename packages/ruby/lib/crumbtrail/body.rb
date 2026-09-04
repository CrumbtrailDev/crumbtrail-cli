require 'json'

module Crumbtrail
  module Body
    LIMIT = 16_384
    POLICY = 'crumbtrail.backend-redaction.v1'
    DENIED = /password|passwd|passphrase|passcode|secret|token|auth|card|cvv|cvc|ssn|email|phone|address|iban|account|birth|credential|creds|cookie|session|privatekey|apikey|accesskey|securitycode|verificationcode|connection|routingnumber|taxid|nationalid|sortcode|name|postal|payload|beforejson|afterjson/i
    class Invalid < StandardError; end
    class UniqueHash
      def initialize; @values = {}; end
      def size; @values.size; end
      def to_h(&block); @values.to_h(&block); end
      def []=(key, value)
        raise Invalid if @values.key?(key)
        @values[key] = value
      end
    end
    def self.capture(bytes, truncated = false)
      return [nil, 'truncated'] if truncated || bytes.bytesize > LIMIT
      return [nil, 'missing'] if bytes.empty?
      removed = [false]
      value = JSON.parse(bytes, max_nesting: 8, object_class: UniqueHash)
      value = walk(value, '', removed)
      encoded = JSON.generate(value)
      return [nil, 'truncated'] if encoded.bytesize > LIMIT
      [encoded, removed[0] ? 'redacted' : 'captured']
    rescue JSON::ParserError, JSON::GeneratorError, Invalid, EncodingError
      [nil, 'invalid']
    end
    def self.walk(value, key, removed)
      words = key.gsub(/([a-z0-9])([A-Z])/, '\1 \2').split(/[^a-zA-Z0-9]+/)
      sensitive = key.gsub(/[^a-zA-Z0-9]/, '').match?(DENIED) || words.any? { |w| w.match?(/\A(?:pwd|pin|pan|otp|pass|sid|dob|zip|jwt|mfa|csrf|xsrf)[0-9]*\z/i) }
      unless sensitive
        case value
        when UniqueHash
          raise Invalid if value.size > 64
          return value.to_h do |k, v|
            raise Invalid unless k.bytesize <= 64 && k.match?(/\A[a-zA-Z_][a-zA-Z0-9_]*\z/)
            [k, walk(v, k, removed)]
          end
        when Array
          raise Invalid if value.size > 40
          return value.map { |v| walk(v, key, removed) }
        when Numeric
          # Large identifiers are withheld even when they do not pass a card checksum.
          return value if value.finite? && value.abs < 1_000_000_000_000
        when TrueClass, FalseClass, NilClass
          return value
        when String
          return value if value.match?(/\A(?:[a-z][a-z_]{0,22}|[A-Z]{3}|[0-9]{1,12})\z/) && !value.match?(/(?:sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[baprs])[-_][a-zA-Z0-9_.=-]{12,}/i)
        end
      end
      removed[0] = true
      '[REDACTED]'
    end
    def self.json?(type)
      type.to_s.split(';', 2).first.to_s.strip.match?(%r{\Aapplication/(?:json|[^/;\s]+\+json)\z}i)
    end
    def self.metadata(field, state)
      { policy: POLICY, fields: state == 'redacted' ? [{ path: field, reason: 'backend_structured_profile', action: 'redacted' }] : [] }
    end
  end
end
