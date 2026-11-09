import { describe, expect, it } from 'vitest';
import type { Policy } from '../shared/types';
import { guardsHost } from './decision';
import { defaultPolicy, normalizePolicy } from './policy';
import { weakeningChanges } from './protection';
import { buildRules, guardedDomains } from './rules';
import { excludeHost, guardedSiteName, listSites, profiledSites } from './sites';

const eff = (over: Partial<Policy['effective']> = {}) => ({ targetDomains: [], guardAll: false, excludeDomains: [], exemptDomains: [], ...over });
const policy = (over: Partial<Policy> = {}) => normalizePolicy({ ...defaultPolicy(), sites: {}, customSites: [], ...over, cloud: { serviceUrl: 'https://pro.example', timeoutMs: 8000 } });

describe('guardsHost', () => {
  it('guards the listed sites only, unless everything is guarded; then all but the allowed and exempt hosts', () => {
    expect(guardsHost(eff({ targetDomains: ['mail.google.com'] }), 'mail.google.com')).toBe(true);
    expect(guardsHost(eff({ targetDomains: ['mail.google.com'] }), 'news.example.com')).toBe(false);
    const all = eff({ guardAll: true, excludeDomains: ['example.com'], exemptDomains: ['pro.example'], targetDomains: ['app.example.com'] });
    expect(guardsHost(all, 'shop.test')).toBe(true);
    expect(guardsHost(all, 'news.example.com')).toBe(false); // allowed, with its subdomains
    expect(guardsHost(all, 'app.example.com')).toBe(true); // a listed site stays guarded under an allowed parent
    expect(guardsHost(all, 'pro.example')).toBe(false);
    expect(guardsHost(all, '')).toBe(false);
  });
});

describe('the effective policy', () => {
  it('keeps allowed hosts only while everything is guarded, cleaned up, and exempts the Pro service', () => {
    const p = policy({ guardAll: true, excludeSites: ['https://www.News.Example.com/a', 'not a host', 'localhost'] });
    expect(p.effective).toMatchObject({ guardAll: true, excludeDomains: ['news.example.com', 'localhost'], exemptDomains: ['pro.example'] });
    expect(policy({ guardAll: false, excludeSites: ['news.example.com'] }).effective).toMatchObject({ guardAll: false, excludeDomains: [] });
    expect(excludeHost('co')).toBeUndefined();
  });

  it("applies every site's whole profile on its hosts while everything is guarded, switched on or not", () => {
    const linkedin = (p: Policy) => p.effective.siteRules.find((r) => r.domains.includes('linkedin.com'));
    const all = policy({ guardAll: true });
    expect(linkedin(all)?.readTrackingShapes).toContain('li:msg:w[read]');
    expect(all.effective.blockedShapes).toContain('li:msg:w');
    expect(all.effective.socketGuards).toContainEqual({ codec: 'whatsapp', domains: ['web.whatsapp.com'] });
    expect(all.effective.profileDomains).toEqual(expect.arrayContaining(['linkedin.com', 'mail.google.com', 'web.whatsapp.com']));
    expect(all.effective.targetDomains).toEqual([]); // the list itself stays as set
    const built = buildRules(all);
    const rule = [...built.reasons].find(([, why]) => why === 'blocked-get-path:action=RESPOND')!;
    expect(built.rules.find((r) => r.id === rule[0])!.condition.requestDomains).toContain('mail.google.com');
    // An allowed host stays unguarded, profile or not.
    const allowed = policy({ guardAll: true, excludeSites: ['linkedin.com'] }).effective;
    expect(allowed.profileDomains).not.toContain('linkedin.com');
    expect(allowed.siteRules.some((r) => r.domains.includes('linkedin.com'))).toBe(false);
    // Without guard every site only the switched-on sites' profiles apply.
    expect(linkedin(policy({ guardAll: false }))).toBeUndefined();
    expect(linkedin(policy({ guardAll: false, sites: { linkedin: { enabled: true } } }))?.readTrackingShapes).toContain('li:msg:w[read]');
  });

  it('profiles every site under guard every site (labels, the notice name), the allowed ones but', () => {
    const ids = (p: Policy) => profiledSites(p).map((s) => s.id);
    expect(ids(policy({ guardAll: true }))).toEqual(expect.arrayContaining(['linkedin', 'gmail', 'whatsapp']));
    expect(ids(policy({ guardAll: true, excludeSites: ['linkedin.com'] }))).not.toContain('linkedin');
    expect(ids(policy({ guardAll: false, sites: { linkedin: { enabled: true } } }))).toEqual(['linkedin']);
    expect(guardedSiteName(policy({ guardAll: true }), 'www.linkedin.com')).toBe('LinkedIn');
    expect(guardedSiteName(policy({ guardAll: false }), 'www.linkedin.com')).toBeUndefined();
  });

  it('lists a site guard every site guards as guarded by it, and an allowed one or a switched-on one not', () => {
    const li = (p: Policy) => listSites(p).find((s) => s.id === 'linkedin')!;
    expect(li(policy({ guardAll: true }))).toMatchObject({ enabled: false, byGuardAll: true });
    expect(li(policy({ guardAll: true, excludeSites: ['linkedin.com'] })).byGuardAll).toBeUndefined();
    expect(li(policy({ guardAll: true, sites: { linkedin: { enabled: true } } })).byGuardAll).toBeUndefined();
    expect(li(policy({ guardAll: false })).byGuardAll).toBeUndefined();
    // An allowed part of the site: off there, on elsewhere on the site.
    const part = policy({ guardAll: true, excludeSites: ['news.linkedin.com'] });
    expect(listSites(part, 'news.linkedin.com').find((s) => s.id === 'linkedin')!.byGuardAll).toBeUndefined();
    expect(listSites(part, 'www.linkedin.com').find((s) => s.id === 'linkedin')!.byGuardAll).toBe(true);
  });
});

describe('guardedDomains, the hosts the rules cover', () => {
  it('names the listed domains, or every host but the allowed ones, never leaving out a listed site', () => {
    expect(guardedDomains(policy({ customSites: [{ id: 'a.test', name: 'A', domains: ['a.test'], enabled: true }] }))).toEqual({ requestDomains: ['a.test'] });
    expect(guardedDomains(policy())).toBeNull();
    const all = guardedDomains(policy({ guardAll: true, excludeSites: ['example.com', 'free.test'], customSites: [{ id: 'app.example.com', name: 'App', domains: ['app.example.com'], enabled: true }] }));
    expect(all).toEqual({ excludedRequestDomains: ['free.test', 'pro.example'] }); // example.com would take app.example.com with it
  });
});

describe('locking', () => {
  it('switching guard-everything off and excluding a host lower protection; switching it on and guarding again do not', () => {
    const on = policy({ guardAll: true, excludeSites: ['a.test'] });
    expect(weakeningChanges(on, policy({ guardAll: false }))).toContain('guard only the listed sites');
    expect(weakeningChanges(on, policy({ guardAll: true, excludeSites: ['a.test', 'b.test'] }))).toEqual(['exclude b.test']);
    expect(weakeningChanges(on, policy({ guardAll: true, excludeSites: [] }))).toEqual([]);
    expect(weakeningChanges(policy(), on)).toEqual([]);
  });
});

describe('the three levels', () => {
  const managed = (guardAll?: object, browser?: object) => ({ version: 1, fetchedAt: 0, sites: {}, customSites: [], ...(guardAll ? { guardAll } : {}), ...(browser ? { browser } : {}) });
  it('guard everything when any level does; a host is allowed only where every such level allows it', () => {
    const acct = policy({ managed: managed({ on: true, excludeSites: ['example.com', 'free.test'] }) } as never);
    expect(acct.effective).toMatchObject({ guardAll: true, excludeDomains: ['example.com', 'free.test'] });
    // This browser allows one more: the account still guards it.
    const both = policy({ guardAll: true, excludeSites: ['news.example.com', 'other.test'], managed: managed({ on: true, excludeSites: ['example.com'] }) } as never);
    expect(both.effective.excludeDomains).toEqual(['news.example.com']);
    // The browser's level from the account page narrows it again.
    const three = policy({ guardAll: true, excludeSites: ['news.example.com'], managed: managed({ on: true, excludeSites: ['example.com'] }, { on: true, excludeSites: [] }) } as never);
    expect(three.effective).toMatchObject({ guardAll: true, excludeDomains: [] });
    // A level that is off adds nothing, and its hosts are no exception.
    expect(policy({ managed: managed({ on: false, excludeSites: ['x.test'] }) } as never).effective.guardAll).toBe(false);
  });
  it('locks a change from the account that switches everything off or allows a host, like one made here', () => {
    const was = policy({ managed: managed({ on: true, excludeSites: [] }) } as never);
    expect(weakeningChanges(was, policy({ managed: managed({ on: true, excludeSites: ['shop.test'] }) } as never))).toEqual(['exclude shop.test']);
    expect(weakeningChanges(was, policy({ managed: managed() } as never))).toContain('guard only the listed sites');
  });
});

describe('sites the account page guards in this browser alone', () => {
  const managed = (browserSites?: object) => ({ version: 1, fetchedAt: 0, sites: { linear: { enabled: true } }, customSites: [], ...(browserSites ? { browserSites } : {}) });
  it('add to the account and this browser; a switch-off from there lowers protection like any other', () => {
    const p = policy({ managed: managed({ sites: { gmail: { enabled: true } }, customSites: [{ id: 'crm.example.com', name: 'CRM', domains: ['crm.example.com'], enabled: true }] }) } as never);
    expect(p.effective.targetDomains).toEqual(expect.arrayContaining(['mail.google.com', 'linear.app', 'crm.example.com']));
    expect(weakeningChanges(p, policy({ managed: managed() } as never))).toEqual(expect.arrayContaining(['switch gmail off', 'remove crm.example.com']));
  });
  it('are left out when malformed or empty', () => {
    expect(policy({ managed: managed({ sites: {}, customSites: [] }) } as never).managed?.browserSites).toBeUndefined();
    expect(policy({ managed: managed({ sites: 'x', customSites: [] }) } as never).managed?.browserSites).toBeUndefined();
  });
});

describe('the rules with everything guarded', () => {
  const rulesOf = (p: Policy) => { const b = buildRules(p); return [...b.reasons].map(([id, why]) => ({ why, c: b.rules.find((r) => r.id === id)!.condition })); };
  const custom = (id: string) => ({ id, name: id, domains: [id], enabled: true });

  it('refuse a POST page load on every guarded host, not the listed ones only', () => {
    const r = rulesOf(policy({ guardAll: true, excludeSites: ['free.test'] })).find((x) => x.why === 'post-navigation')!;
    expect(r.c.requestDomains).toBeUndefined();
    expect(r.c.excludedRequestDomains).toEqual(['free.test', 'pro.example']);
    expect(r.c.resourceTypes).toEqual(['main_frame', 'sub_frame']);
    // Without it, the listed sites' domains, as before; none listed, no rule.
    expect(rulesOf(policy({ customSites: [custom('a.test')] })).find((x) => x.why === 'post-navigation')!.c.requestDomains).toEqual(['a.test']);
    expect(rulesOf(policy()).find((x) => x.why === 'post-navigation')).toBeUndefined();
  });

  it('refuse sockets on every guarded host, leaving out the sites that allow them and the allowed hosts', () => {
    const p = policy({ guardAll: true, excludeSites: ['free.test', 'google.com'], sites: { gmail: { enabled: true }, linear: { enabled: true } } });
    const r = rulesOf(p).find((x) => x.why === 'websocket')!;
    expect(r.c.requestDomains).toBeUndefined();
    expect(r.c.resourceTypes).toEqual(['websocket', 'webtransport']);
    expect(r.c.excludedRequestDomains).toEqual(expect.arrayContaining(['free.test', 'pro.example', 'linear.app'])); // Linear's sync socket carries its reads
    expect(r.c.excludedRequestDomains).not.toContain('google.com'); // mail.google.com, which blocks sockets, is under it
    // The global default allowing sockets: the listed blocking sites' domains only, as before.
    const allowing = rulesOf(policy({ guardAll: true, websockets: 'allow', sites: { gmail: { enabled: true } } })).find((x) => x.why === 'websocket')!;
    expect(allowing.c.requestDomains).toContain('mail.google.com');
    expect(allowing.c.excludedRequestDomains).toBeUndefined();
  });
});

describe('an allowed child under a listed site', () => {
  const custom = (id: string, domains = [id]) => ({ id, name: id, domains, enabled: true });
  it('stays covered by every rule, as guardsHost guards it', () => {
    const p = policy({ guardAll: true, excludeSites: ['child.localhost', 'free.test'], customSites: [custom('parent', ['localhost'])] });
    expect(guardsHost(p.effective, 'child.localhost')).toBe(true);
    expect(guardedDomains(p)).toEqual({ excludedRequestDomains: ['free.test', 'pro.example'] });
    const b = buildRules(p);
    for (const [id, why] of b.reasons) {
      // The socket rule also leaves out Linear, whose profile allows sockets and applies, on or off, under guard every site.
      const out = why === 'websocket' ? ['free.test', 'pro.example', 'linear.app'] : ['free.test', 'pro.example'];
      if (why === 'post-navigation' || why === 'websocket' || why === 'mutating-method') {
        expect(b.rules.find((r) => r.id === id)!.condition.excludedRequestDomains, why).toEqual(out);
      }
    }
  });
});

