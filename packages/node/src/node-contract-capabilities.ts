/**
 * Runtime capability marker for the crumbtrail-node package contract.
 *
 * A consumer that cannot rely on semver alone reads this map through a
 * namespace import and enables a feature only when the corresponding key
 * reads exactly `true`. An absent or malformed marker fails closed, so this
 * module is the single source of truth and must stay a plain, statically
 * analyzable const: no computed keys, no conditional construction, nothing
 * a bundler could tree shake or reshape.
 *
 * The map is currently EMPTY, and that is the contract, not an oversight.
 * Every key it used to carry described a third-party integration surface this
 * package no longer implements:
 *
 *   - `tenantContextFactory`         — createServer's per-tenant evidence-source seam
 *   - `ticketComment`                — the provider-neutral ticket comment writer
 *   - `evidenceSourceFetchInjection` — fetch injection into evidence providers
 *
 * Those left along with `evidence-sources/`, `ticket/`, and `knowledge/`: that
 * data now reaches agents through each vendor's own MCP server rather than
 * through a package installed in the customer's node_modules. Because the cloud
 * accepts `=== true` only, dropping the keys disables those paths by
 * construction, which is safer than keeping a marker that lies about what the
 * package can still do.
 */
export const NODE_CONTRACT_CAPABILITIES = {} as const;
