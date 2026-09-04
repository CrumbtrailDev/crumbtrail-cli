require 'net/http'
require 'uri'
require 'json'

module Crumbtrail
  class Sender
    def initialize(endpoint:, key:, cert_store: nil)
      @endpoint = URI(endpoint)
      raise ArgumentError, 'Crumbtrail requires HTTPS without credentials, query or fragment' unless @endpoint.is_a?(URI::HTTPS) && @endpoint.host && !@endpoint.userinfo && !@endpoint.query && !@endpoint.fragment
      raise ArgumentError, 'Crumbtrail ingest key is required' if key.to_s.strip.empty? || key.match?(/[[:cntrl:]]/)
      @key = key
      @cert_store = cert_store
      @queue = SizedQueue.new(64)
      @worker = Thread.new do
        while (batch = @queue.pop)
          deliver(batch)
        end
      end
    end
    def enqueue(batch)
      @queue.push(JSON.generate(batch), true)
      true
    rescue ThreadError, ClosedQueueError, JSON::GeneratorError
      false
    end
    # Closing the queue allows queued batches to drain within the caller's deadline.
    def close(timeout: 5)
      @queue.close
      !!@worker.join(timeout)
    end
    private
    def deliver(payload)
      4.times do |attempt|
        begin
          uri = @endpoint.dup
          uri.path = '/api/events'
          req = Net::HTTP::Post.new(uri)
          req['Authorization'] = "Bearer #{@key}"
          req['Content-Type'] = 'application/json'
          req.body = payload
          options = { use_ssl: true, open_timeout: 2, read_timeout: 3, write_timeout: 3 }
          options[:cert_store] = @cert_store if @cert_store
          res = Net::HTTP.start(uri.host, uri.port, **options) { |http| http.request(req) }
          return if res.code == '200'
          return unless [404, 429].include?(res.code.to_i) || res.code.to_i >= 500
        rescue StandardError
          # Delivery errors do not escape into customer work or expose payloads.
        end
        sleep(0.25 * (attempt + 1)) if attempt < 3
      end
    end
  end
end
