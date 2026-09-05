require 'json'

module Crumbtrail
  # Structured body policy. Ruby, Go and the ASP.NET Core package implement the same rules and
  # are driven by the same corpus in `test-fixtures/backend-body/cases.json`, so a divergence
  # between them fails a test instead of quietly producing three different bodies.
  module Body
    LIMIT = 16_384
    POLICY = 'crumbtrail.backend-redaction.v1'
    MAX_NESTING = 8
    MAX_KEYS = 64
    MAX_ITEMS = 40
    # Well below a phone number (10), a national insurance number (9) and a card (13 to 19).
    MAX_INTEGER_DIGITS = 6
    SAFE_INTEGER = 9_007_199_254_740_991
    DENIED = /password|passwd|passphrase|passcode|secret|token|auth|card|cvv|cvc|ssn|email|phone|address|iban|account|birth|credential|creds|cookie|session|privatekey|apikey|accesskey|securitycode|verificationcode|connection|routingnumber|taxid|nationalid|sortcode|name|postal|payload|beforejson|afterjson|mobile|contact|diagnosis|medical|patient|prescription|gender|ethnic|religion|salary|income|identifier|username|passport|insurance|beneficiary|guardian|occupation|citizen|latitude|longitude|coordinate|geolocation|province|country|street/i
    # Short words that appear inside innocent identifiers ("capacity" contains "city"), so they
    # are matched as whole words rather than as substrings.
    DENIED_WORD = /\A(?:pwd|pin|pan|otp|pass|sid|dob|zip|jwt|mfa|csrf|xsrf|city|town|geo|cell|race|sex|age|location|lat|lng|lon|gps)s?[0-9]*\z/i
    SAFE_STRING = /\A(?:[a-z][a-z_]{0,22}|[A-Z]{3}|[0-9]{1,#{MAX_INTEGER_DIGITS}})\z/
    TOKEN_STRING = /(?:sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[baprs])[-_][a-zA-Z0-9_.=-]{12,}/i
    FIELD_NAME = /\A[a-zA-Z_][a-zA-Z0-9_]*\z/
    REDACTED = '[REDACTED]'.freeze

    class Invalid < StandardError; end

    def self.capture(bytes, truncated = false)
      return [nil, 'truncated'] if truncated || bytes.bytesize > LIMIT
      return [nil, 'missing'] if bytes.empty?
      removed = [false]
      value = JSON.parse(bytes, max_nesting: MAX_NESTING, allow_duplicate_key: false)
      value = walk(value, '', removed)
      encoded = JSON.generate(value)
      return [nil, 'truncated'] if encoded.bytesize > LIMIT
      [encoded, removed[0] ? 'redacted' : 'captured']
    rescue JSON::ParserError, JSON::GeneratorError, JSON::NestingError, Invalid, EncodingError
      [nil, 'invalid']
    end

    # A sensitive key is redacted whole. The subtree under it is never walked, so a malformed
    # or oversized value inside a secret cannot turn the whole body into `invalid` and cannot
    # be inspected on the way to being dropped.
    def self.walk(value, key, removed)
      unless sensitive?(key)
        case value
        when Hash
          raise Invalid if value.size > MAX_KEYS
          return value.to_h do |k, v|
            raise Invalid unless k.bytesize <= 64 && k.match?(FIELD_NAME)
            [k, walk(v, k, removed)]
          end
        when Array
          raise Invalid if value.size > MAX_ITEMS
          return value.map { |v| walk(v, key, removed) }
        when Numeric
          return value if number?(value)
        when TrueClass, FalseClass, NilClass
          return value
        when String
          return value if value.match?(SAFE_STRING) && !value.match?(TOKEN_STRING)
        end
      end
      removed[0] = true
      REDACTED
    end

    def self.sensitive?(key)
      words = key.gsub(/([a-z0-9])([A-Z])/, '\1 \2').split(/[^a-zA-Z0-9]+/)
      key.gsub(/[^a-zA-Z0-9]/, '').match?(DENIED) || words.any? { |word| word.match?(DENIED_WORD) }
    end

    # The integer digit cap already excludes every card length. Luhn stays because it also
    # catches a card smuggled across a decimal point, where the integer part is short.
    def self.number?(value)
      return false unless value.finite?
      return false if value.abs > SAFE_INTEGER
      return false if value.to_i.abs.to_s.length > MAX_INTEGER_DIGITS
      !luhn?(digits(value))
    end

    def self.digits(value)
      value.abs.to_s.gsub(/[^0-9]/, '')
    end

    def self.luhn?(digits)
      return false unless digits.length.between?(13, 19)
      sum = 0
      twice = false
      digits.reverse.each_char do |char|
        n = char.ord - 48
        if twice
          n *= 2
          n -= 9 if n > 9
        end
        sum += n
        twice = !twice
      end
      (sum % 10).zero?
    end

    def self.json?(type)
      type.to_s.split(';', 2).first.to_s.strip.match?(%r{\Aapplication/(?:json|[^/;\s]+\+json)\z}i)
    end

    def self.metadata(field, state)
      { policy: POLICY, fields: state == 'redacted' ? [{ path: field, reason: 'backend_structured_profile', action: 'redacted' }] : [] }
    end
  end
end
