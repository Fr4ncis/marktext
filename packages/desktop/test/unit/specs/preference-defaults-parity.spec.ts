import { describe, expect, it } from 'vitest'
import schema from '../../../src/main/preferences/schema.json'
import defaults from '../../../static/preference.json'

// `Preference.init()` treats static/preference.json as the list of settings that
// exist: on every start, any key in the store that is missing from that file is
// deleted. A setting declared only in schema.json therefore validates fine,
// saves fine, and is silently wiped the next time the app opens.
//
// That is how every `ai*` preference — provider, model, base URL, prompt
// library, personas — came to reset on restart: the schema had them, the
// defaults file did not. The two files are one contract in two halves, so pin
// them together rather than trusting the next feature to remember both.
//
// Only the key sets are pinned. The default *values* are allowed to diverge and
// four of them do: a fresh profile is seeded from static/preference.json, so its
// value wins and the schema's is a fallback that never applies.

type Json = Record<string, unknown>

const schemaEntries = schema as unknown as Record<string, { default?: unknown }>
const defaultEntries = defaults as unknown as Json

describe('preferences: schema and static defaults describe the same settings', () => {
  it('every schema setting has an entry in static/preference.json', () => {
    const missing = Object.keys(schemaEntries).filter((key) => !(key in defaultEntries))
    // Anything listed here would be deleted from a user's store on next start.
    expect(missing).toEqual([])
  })

  it('every static default is a declared setting', () => {
    // The reverse direction is not destructive, but an undeclared key is stored
    // without validation and is invisible to the schema's own documentation.
    const undeclared = Object.keys(defaultEntries).filter((key) => !(key in schemaEntries))
    expect(undeclared).toEqual([])
  })
})
