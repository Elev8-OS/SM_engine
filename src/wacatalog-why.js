import { catalogId, waCatalogSettings } from './wacatalog.js';
import { graph } from './meta.js';

/**
 * Why does the catalog not show in the chat? Collects what Meta says in four short parts (the probe keeps only the first part of an answer):
 *   part 1  the catalog: name, type, owner, number of products, product sets
 *   part 2  the number: status, official account, business profile (what is filled in), commerce settings
 *   part 3  the business: verification, which catalogs and WhatsApp accounts it owns
 *   part 4  the WhatsApp account and the diagnostics Meta keeps for the catalog
 * Every step reports its own error, so a missing permission is named instead of hiding the rest.
 */
export async function whyState(part = 1) {
  const s = waCatalogSettings();
  const catalog = await catalogId();
  const cut = (e, n = 110) => String(e?.message || e).replace(/\s+/g, ' ').slice(0, n);
  const step = async (label, fn) => {
    try {
      return `${label}: ${await fn()}`;
    } catch (e) {
      return `${label} ERR ${cut(e)}`;
    }
  };
  const lines = [];
  if (part === 1) {
    lines.push(await step('catalog', async () => {
      const c = await graph('GET', catalog, { fields: 'name,vertical,product_count,business{id,name}' });
      return `${c.name} | type ${c.vertical} | n ${c.product_count} | owner ${c.business?.id} ${c.business?.name || ''} | env business ${s.businessId || 'not set'}`;
    }));
    lines.push(await step('sets', async () => {
      const r = await graph('GET', `${catalog}/product_sets`, { fields: 'name,product_count', limit: 20 });
      return (r.data || []).map((x) => `${x.name}(${x.product_count})`).join(' ') || 'none';
    }));
  } else if (part === 2) {
    lines.push(await step('number', async () => {
      const p = await graph('GET', s.phoneId, { fields: 'status,account_mode,is_official_business_account,messaging_limit_tier,platform_type' });
      return `status ${p.status} | mode ${p.account_mode} | official ${p.is_official_business_account} | tier ${p.messaging_limit_tier} | ${p.platform_type}`;
    }));
    lines.push(await step('profile', async () => {
      const r = await graph('GET', `${s.phoneId}/whatsapp_business_profile`, { fields: 'about,address,description,email,profile_picture_url,websites,vertical' });
      const x = r.data?.[0] || r;
      return `about ${String(x.about || '').length}c | desc ${String(x.description || '').length}c | picture ${x.profile_picture_url ? 'yes' : 'NO'} | sites ${(x.websites || []).length} | email ${x.email ? 'yes' : 'no'} | address ${x.address ? 'yes' : 'no'} | vertical ${x.vertical || 'none'}`;
    }));
    lines.push(await step('commerce', async () => JSON.stringify((await graph('GET', `${s.phoneId}/whatsapp_commerce_settings`)).data?.[0] ?? {}).slice(0, 140)));
  } else if (part === 3) {
    lines.push(await step('business', async () => {
      const b = await graph('GET', s.businessId, { fields: 'name,verification_status' });
      return `${b.name} | verification ${b.verification_status}`;
    }));
    lines.push(await step('owns catalogs', async () => ((await graph('GET', `${s.businessId}/owned_product_catalogs`, { fields: 'name', limit: 20 })).data || []).map((x) => `${x.id} ${x.name}`).join(' ; ') || 'none'));
    lines.push(await step('owns WABA', async () => ((await graph('GET', `${s.businessId}/owned_whatsapp_business_accounts`, { fields: 'name', limit: 20 })).data || []).map((x) => `${x.id} ${x.name}`).join(' ; ') || 'none'));
    lines.push(await step('client WABA', async () => ((await graph('GET', `${s.businessId}/client_whatsapp_business_accounts`, { fields: 'name', limit: 20 })).data || []).map((x) => `${x.id} ${x.name}`).join(' ; ') || 'none'));
  } else if (part === 4) {
    lines.push(await step('waba', async () => {
      const w = await graph('GET', s.wabaId, { fields: 'name,account_review_status,business_verification_status,ownership_type,currency' });
      return `${w.name} | review ${w.account_review_status} | verification ${w.business_verification_status} | ${w.ownership_type} | ${w.currency}`;
    }));
    lines.push(await step('diagnostics', async () => JSON.stringify((await graph('GET', `${catalog}/diagnostics`, { fields: 'type,diagnostics' })).data || []).slice(0, 420)));
  } else if (part === 5) {
    // How many products are approved, pending or rejected by Meta (the status the chat symbol depends on), counted with Meta's own filter.
    for (const st of ['approved', 'pending', 'rejected']) {
      lines.push(await step(st, async () => {
        const r = await graph('GET', `${catalog}/products`, { fields: 'retailer_id', filter: { review_status: { eq: st } }, limit: 50 });
        return `${(r.data || []).length}${(r.data || []).length ? ` (${(r.data || []).map((x) => String(x.retailer_id).replace(/^(villa|apartment)-/, '')).join(' ')})` : ''}`;
      }));
    }
    lines.push(await step('one product', async () => {
      const r = await graph('GET', `${catalog}/products`, { fields: 'retailer_id,review_status,review_rejection_reasons,visibility,availability,status', limit: 1 });
      return JSON.stringify(r.data?.[0] ?? {}).slice(0, 260);
    }));
  } else {
    // Who is connected to the WhatsApp account and the catalog: the apps that receive its events and the users with access.
    lines.push(await step('apps', async () => ((await graph('GET', `${s.wabaId}/subscribed_apps`)).data || []).map((x) => x.whatsapp_business_api_data?.name || x.name || x.id).join(' ; ') || 'none'));
    lines.push(await step('waba users', async () => ((await graph('GET', `${s.wabaId}/assigned_users`, { business: s.businessId, fields: 'name,tasks' })).data || []).map((x) => `${x.name}[${(x.tasks || []).join(',')}]`).join(' ; ') || 'none'));
    lines.push(await step('catalog users', async () => ((await graph('GET', `${catalog}/assigned_users`, { business: s.businessId, fields: 'name,tasks' })).data || []).map((x) => `${x.name}[${(x.tasks || []).join(',')}]`).join(' ; ') || 'none'));
  }
  return { part, s: lines.join(' || ') };
}

export function whyRoutes(app, needDb, ah) {
  app.get('/wa-catalog/why', needDb, ah(async (req, res) => res.json(await whyState(Number(req.query.part) || 1))));
}

