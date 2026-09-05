require 'crumbtrail'
require 'active_support/notifications'

module Crumbtrail
  module ActiveRecord
    # Query text and bindings are intentionally withheld. This works across SQL dialects
    # without treating a partial SQL parser as a privacy boundary.
    ENGINES = %w[postgres mysql sqlite].freeze
    MUTEX = Mutex.new
    # Rails issues schema reflection and query cache hits inside application requests. They are
    # not statements the application asked for, and they spend the per request event budget the
    # application's own statements need.
    IGNORED_NAMES = %w[SCHEMA CACHE].freeze
    MAX_PENDING = 1024
    OPERATIONS = %w[SELECT INSERT UPDATE DELETE].freeze
    OPERATION = /\A(?:SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i

    # An evented subscriber, so the sequence and the timestamp are both taken when the statement
    # is issued rather than when it completes. Stamping at completion sorts a slow query after
    # faster ones issued after it, and leaves `seq` contradicting `t`.
    class Subscriber
      def initialize(engine)
        @engine = engine
      end

      def start(_name, id, payload)
        return if ignore?(payload)
        context = Crumbtrail.current
        return unless context
        pending = (Thread.current[:crumbtrail_sql_pending] ||= {})
        # A statement whose completion notification never arrives would otherwise retain its
        # context for the life of the thread.
        return if pending.size >= MAX_PENDING
        pending[id] = [context, context.next_sequence, Crumbtrail.now, Process.clock_gettime(Process::CLOCK_MONOTONIC)]
      rescue StandardError
        nil
      end

      def finish(_name, id, payload)
        state = Thread.current[:crumbtrail_sql_pending]&.delete(id)
        return unless state
        context, sequence, at, started = state
        sql = payload[:sql].to_s
        sql = '' if sql.bytesize > 32_768
        operation = sql.lstrip[OPERATION]&.upcase || 'OTHER'
        data = { engine: @engine, op: OPERATIONS.include?(operation) ? operation.downcase : 'other', table: nil,
                 shape: '[statement omitted]',
                 rowCount: payload[:row_count].is_a?(Integer) ? payload[:row_count] : nil,
                 rowEvidence: 'not_captured',
                 durationMs: (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started) * 1000,
                 cached: !!payload[:cached] }
        error = payload[:exception_object]
        data.merge!(errorName: error.class.name, code: nil, category: 'unknown') if error
        context.database(error ? 'db.error' : 'db.statement', data, sequence: sequence, time: at)
      rescue StandardError
        nil
      end

      private

      def ignore?(payload)
        IGNORED_NAMES.include?(payload[:name].to_s) || !!payload[:cached]
      end
    end

    def self.install(engine:)
      raise ArgumentError, 'Unsupported database engine' unless ENGINES.include?(engine)
      MUTEX.synchronize do
        if @subscription
          # A second install with a different engine used to be discarded in silence, and every
          # event after it named the first engine.
          raise ArgumentError, "Crumbtrail ActiveRecord capture is already installed for #{@engine}" unless @engine == engine
          return @subscription
        end
        @engine = engine
        @subscription = ActiveSupport::Notifications.subscribe('sql.active_record', Subscriber.new(engine))
      end
    end

    def self.uninstall
      MUTEX.synchronize do
        ActiveSupport::Notifications.unsubscribe(@subscription) if @subscription
        @subscription = nil
        @engine = nil
      end
    end
  end
end
