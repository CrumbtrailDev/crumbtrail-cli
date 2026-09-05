module Crumbtrail
  VERSION = '0.1.0'
  SCHEMA_VERSION = 1
  PLATFORM = 'ruby'
  SDK = { name: 'crumbtrail-ruby', version: VERSION }.freeze

  def self.now
    (Time.now.to_f * 1000).to_i
  end

  # Wire envelope for every event. `schemaVersion`, `platform` and `sdk` are required of every
  # SDK that is not built on crumbtrail-core: without them ingest defaults the event to
  # `platform: "web"` and no reader can tell a Rails request apart from a browser one.
  # `capabilities` and `target` are the remaining envelope fields. This SDK never populates
  # them, and they are accepted here so the wire contract fixtures can be exercised through
  # the real serializer rather than a copy of it.
  def self.event(time, kind, data, platform: PLATFORM, sdk: SDK, capabilities: nil, target: nil)
    event = { t: time, k: kind, d: data, schemaVersion: SCHEMA_VERSION, platform: platform, sdk: sdk }
    event[:capabilities] = capabilities if capabilities && !capabilities.empty?
    event[:target] = target if target && !target.empty?
    event
  end
end
