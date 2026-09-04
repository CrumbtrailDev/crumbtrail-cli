# Capture Rack and Rails requests

Requires Ruby 3.2 or later and Rack 2 or 3. This package is source only until a RubyGems release is published. In a checkout, run `gem build crumbtrail.gemspec` and install the resulting gem. Applications can use a Bundler `path` dependency on this directory during local verification.

```ruby
require 'crumbtrail'
sender = Crumbtrail::Sender.new(endpoint: ENV.fetch('CRUMBTRAIL_ENDPOINT'), key: ENV.fetch('CRUMBTRAIL_INGEST_KEY'))
# config.ru, after the application's normal requires
use Crumbtrail::Middleware, sink: sender, service: 'api', routes: ->(env) { env['PATH_INFO'].start_with?('/api/') && !env['PATH_INFO'].start_with?('/api/auth') }
at_exit { sender.close(timeout: 5) }
```

For Rails, use the same keyword arguments with `config.middleware.use Crumbtrail::Middleware` in your application configuration. Initialize the sender inside each worker process after any application server fork.

Both valid `x-crumbtrail-session-id` and `x-crumbtrail-request-id` headers are required. The browser SDK must register that session. No routes are captured unless the `routes` predicate returns true. Hijack capable requests bypass capture. Query strings and headers are never captured. Route paths can contain identifiers, so enable only suitable routes.

JSON capture preserves bounded numeric operands, booleans, null, short enums and currency codes. Sensitive names and other strings are redacted. Large numeric identifiers are withheld. Bodies over 16 KiB are withheld with `truncated` state. Malformed, ambiguous, or structurally excessive JSON has `invalid` state. Non JSON or empty bodies have `missing` state. The request is observed as the application reads it. Unread bodies are missing and partial reads can be invalid. Response chunks are forwarded unchanged and captured when Rack enumerates the body. Closing the body finalizes delivery once.

The queue holds 64 batches and drops new batches when full. Each request holds at most 200 database events plus request boundary events and reports an event limit gap. The optional `cert_store` accepts an OpenSSL certificate store for private trust roots and keeps certificate verification enabled. A sender uses HTTPS, does not follow redirects, and retries transient failures up to four attempts. `close(timeout: 5)` waits at most five seconds and returns whether draining completed. It does not kill an in progress network request. Abrupt process termination can lose queued events.

## Capture ActiveRecord commands

Requires ActiveSupport and ActiveRecord from the application. Install once during initialization:

```ruby
require 'crumbtrail/active_record'
Crumbtrail::ActiveRecord.install(engine: 'postgres')
```

Accepted engines are `postgres`, `mysql`, and `sqlite`. The adapter records operation, duration, statement sequence, reported row count, and exception class within captured requests, including queries during response enumeration. It deliberately withholds SQL, bindings and row values. It does not claim before/after snapshots, transaction correlation or database read evidence. `Crumbtrail::ActiveRecord.uninstall` removes the subscription.

Run `ruby -Ilib test/capture_test.rb` with Rack, ActiveRecord, SQLite3 and Minitest installed. Set `CRUMBTRAIL_CAPTURE_CONTRACT_OUTPUT=/tmp/ruby-capture.json` to export the real Rack test's batches for consumer contract checks.
