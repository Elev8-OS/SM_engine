// The Elev8 name a promo code is limited to for an apartment category.
// All units of a category share ONE Elev8 listing (the same listing id), but each unit is a row of its own, and
// create_promo_code wants a name that matches exactly one row. So among the rows of the category we take the listing
// name that no other row carries (for the mezzanines "8 - 11 Mezzanine", for the plunge pool units "1 - 3 Plunge Pool").
// The code then covers the whole listing, that is every unit of the category.
export function categoryListingNames(rows, pick) {
  const all = rows || [];
  const nameOf = (r) => String(r.listing_name || '').trim();
  const count = (n) => all.filter((r) => nameOf(r) === n).length;
  const unique = all.filter(pick).map(nameOf).filter((n) => n && count(n) === 1);
  return [...new Set(unique)].slice(0, 1);
}
