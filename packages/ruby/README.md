# Capture Rack and Rails requests

Requires Ruby 3.2 or later and Rack 2 or 3. This package is source only until a RubyGems release is published. In a checkout, run `gem build crumbtrail.gemspec` and install the resulting gem. Applications can use a Bundler `path` dependency on this directory during local verification.

```ruby
require 'crumbtrail'
sender = Crumbtrail::Sender.new(endpoint: ENV.fetch('CRUMBTRAIL_ENDPOINT'), key: ENV.fetch('CRUMBTRAIL_INGEST_KEY'), logger: Rails.logger)
# config.ru, after the application's normal requires
use Crumbtrail::Middleware, sink: sender, service: 'api', routes: ->(env) { env['PATH_INFO'].start_with?('/api/') && !env['PATH_INFO'].start_with?('/api/auth') }
at_exit { sender.close(timeout: 5) }
```

For Rails, use the same keyword arguments with `config.middleware.use Crumbtrail::Middleware` in your application configuration. Initialize the sender inside each worker process after any application server fork.

Both valid `x-crumbtrail-session-id` and `x-crumbtrail-request-id` headers are required. The browser SDK must register that session. No routes are captured unless the `routes` predicate returns true. Upgrade requests and responses that execute or arrange Rack hijacking bypass capture. A server advertising hijack capability still captures ordinary requests. Query strings, headers and raw paths are never captured. The optional `route` callback can return an application configured template such as `/api/orders/:id`. Its default is `/`. Do not return a path containing actual parameter values.

JSON capture preserves bounded numeric operands, booleans, null, short enums and currency codes. Sensitive names and other strings are redacted, and a sensitive name redacts its whole subtree without walking it. A number is kept only when it stays inside the safe integer range, has at most six integer digits, and is not a valid card number. That cap is below the length of a phone number, a national identifier or an account number, so those are withheld even under an innocent field name. Strings are kept only as a short lowercase word, a three letter uppercase code, or at most six digits. The Ruby, Go and ASP.NET Core packages all run `test-fixtures/backend-body/cases.json`, so the three agree on every case in it. Bodies over 16 KiB are withheld with `truncated` state. Malformed, ambiguous, or structurally excessive JSON has `invalid` state. Non JSON or empty bodies have `missing` state. The request is observed as the application reads it. Unread bodies are missing. A nonempty request body is withheld as truncated unless it exactly matches a declared Content Length, or a full read or EOF proves completeness when no length was declared. Response chunks are forwarded unchanged and captured when Rack enumerates the body. Closing the body finalizes delivery once. Callable Rack streaming bodies receive the original stream unchanged and report missing response body evidence. Their request evidence and response status are still recorded. Enumerable response failures with partial bytes report truncated response evidence.

The queue holds 64 batches and refuses new batches when full. A refused batch is a hole in the session, so the request records a `buffer_overflow` capture gap naming how many events were lost. Each request holds at most 200 database events plus request boundary events and reports an event limit gap.

The optional `cert_store` accepts an OpenSSL certificate store for private trust roots and keeps certificate verification enabled. A sender uses HTTPS and does not follow redirects. It retries network errors, 429 and server errors up to four attempts. Any other status is permanent: repeating it cannot help, so the sender records a `delivery_failed` capture gap and writes one line to `logger`, or to `warn` when no logger was given. Without that line a revoked key looks exactly like a working SDK with an empty project.

The cloud can also answer 202 with `{"capture":"shed"}` and a retry window, which means it accepted the request and discarded the evidence. The sender pauses delivery for the window, counts what it drops, and sends one capture gap naming the shed reason once the window passes.

`close(timeout: 5)` waits at most five seconds for the queue to drain, then cancels the worker, and returns whether draining completed. A retry backoff cannot hold process exit open past the timeout the caller asked for. Abrupt process termination can still lose queued events.

## Capture ActiveRecord commands

Requires ActiveSupport and ActiveRecord from the application. Install once during initialization:

```ruby
require 'crumbtrail/active_record'
Crumbtrail::ActiveRecord.install(engine: 'postgres')
```

Accepted engines are `postgres`, `mysql`, and `sqlite`. Installing twice with the same engine is a no op; installing a second, different engine raises `ArgumentError` rather than silently keeping the first. The adapter records operation, duration, statement sequence, reported row count, and exception class within captured requests, including queries during response enumeration. Statement order is the order the application issued statements in, so both the sequence and the timestamp are taken before the statement runs; `durationMs` recovers the completion time. Rails schema and query cache statements are ignored so they cannot spend the request's event budget. It deliberately withholds SQL, bindings and row values. It does not claim before/after snapshots, transaction correlation or database read evidence. `Crumbtrail::ActiveRecord.uninstall` removes the subscription.

Run `pnpm test:ruby` from the repository root, or `bundle exec ruby -Ilib -Itest test/capture_test.rb` here, with Rack, ActiveRecord, SQLite3 and Minitest installed. Set `CRUMBTRAIL_CAPTURE_CONTRACT_OUTPUT=/tmp/ruby-capture.json` to export the real Rack test's batches for consumer contract checks.
