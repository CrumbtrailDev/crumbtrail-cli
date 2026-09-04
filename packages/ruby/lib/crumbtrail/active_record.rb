require 'crumbtrail'
require 'active_support/notifications'

module Crumbtrail
  module ActiveRecord
    # Query text and bindings are intentionally withheld. This works across SQL dialects
    # without treating a partial SQL parser as a privacy boundary.
    def self.install(engine:)
      raise ArgumentError, 'Unsupported database engine' unless %w[postgres mysql sqlite].include?(engine)
      @mutex ||= Mutex.new
      @mutex.synchronize do
        @subscription ||= ActiveSupport::Notifications.monotonic_subscribe('sql.active_record') do |_name, start, finish, _id, payload|
          context = Crumbtrail.current
          next unless context
          sql = payload[:sql].to_s
          sql = '' if sql.bytesize > 32_768
          operation = sql.lstrip[/\A(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i]&.upcase || 'OTHER'
          data = { engine: engine, op: %w[SELECT INSERT UPDATE DELETE].include?(operation) ? operation.downcase : 'other', table: nil, shape: '[statement omitted]', rowCount: payload[:row_count].is_a?(Integer) ? payload[:row_count] : nil, rowEvidence: 'not_captured', durationMs: (finish - start) * 1000, cached: !!payload[:cached] }
          error = payload[:exception_object]
          data.merge!(errorName: error.class.name, code: nil, category: 'unknown') if error
          context.database(error ? 'db.error' : 'db.statement', data)
        rescue StandardError
          nil
        end
      end
    end
    def self.uninstall
      @mutex ||= Mutex.new
      @mutex.synchronize do
        ActiveSupport::Notifications.unsubscribe(@subscription) if @subscription
        @subscription = nil
      end
    end
  end
end
