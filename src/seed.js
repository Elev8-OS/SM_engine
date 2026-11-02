import { q } from './db.js';

const BASE = 'https://www.elevate-villas.com/property/';

// Facts from the website and Elev8. Only confirmed details go into highlights.
export const PROPERTIES = [
  { key: 'patuha', name: 'The R Villa Patuha', area: 'Pererenan', type: 'villa', guests: 8, size_m2: 240, bedrooms: '3 en-suite bedrooms + office with sofa bed', url: BASE + 'tranquil-the-r-villa-patuha-pool-rice-field-views-aa8a3a82', highlights: 'Private pool facing rice fields; office with desk, WiFi and sofa bed; fully equipped kitchen; free parking; air conditioning in sleeping areas; no pets' },
  { key: 'dempo', name: 'The R Villa Dempo', area: 'Pererenan', type: 'villa', guests: 4, size_m2: 250, bedrooms: '2', url: BASE + 'tropical-2br-the-r-villa-dempo-w-pool-pererenan-e9830345', highlights: 'Pool', open_questions: 'Photos missing. Facts to be confirmed', active: false },
  { key: 'luwa', name: 'The R Villa Luwa', area: 'Pererenan', type: 'villa', guests: 10, bedrooms: '5', url: BASE + '5br-pool-the-r-villa-luwa-serene-near-canggu-e63f4ec8', highlights: 'Pool; near Canggu', open_questions: 'Facts to be confirmed' },
  { key: 'bratan', name: 'The R Villa Bratan', area: 'Canggu', type: 'villa', guests: 6, size_m2: 250, bedrooms: '3', url: BASE + 'bratan-the-r-bratan-3br-serene-getaway-in-canggu-231b77fd', highlights: 'Serene getaway in Canggu', open_questions: 'Facts to be confirmed' },
  { key: 'swantika', name: 'The R Villa Swantika', area: 'Pererenan', type: 'villa', guests: 4, size_m2: 220, bedrooms: '2', url: BASE + 'modern-2br-the-r-villa-swantika-w-pool-pererenan-923c8fc3', highlights: 'Pool; green nature views', open_questions: 'Facts to be confirmed' },
  { key: 'ranakah', name: 'The R Villa Ranakah', area: 'Pererenan', type: 'villa', guests: 6, size_m2: 200, bedrooms: '3', url: BASE + 'cozy-meets-luxe-3br-the-r-villa-ranakah-stay-27dc3e6a', highlights: 'Cozy and luxe design', open_questions: 'Photos missing. Facts to be confirmed', active: false },
  { key: 'masurai', name: 'The R Villa Masurai', area: 'Pererenan', type: 'villa', guests: 4, size_m2: 250, bedrooms: '2', url: BASE + 'masurai-pererenan-the-r-villa-masurai-2br-pool-w-cinema-e87b4599', highlights: 'Pool; cinema room', open_questions: 'Facts to be confirmed' },
  { key: 'samalas', name: 'The R Villa Samalas', area: 'Pererenan', type: 'villa', guests: 8, size_m2: 300, bedrooms: '4', url: BASE + 'the-r-villa-samalas-4br-retreat-in-pererenan-a1200ded', highlights: 'Retreat in Pererenan', open_questions: 'Elev8 and website say 8 guests, Vrbo says 10. Facts to be confirmed' },
  { key: 'tambora', name: 'The R Villa Tambora', area: 'Canggu', type: 'villa', guests: 6, size_m2: 250, bedrooms: '3', url: BASE + 'tambora-the-r-tambora-stylish-3br-tropical-escape-fec4d1c7', highlights: 'Stylish tropical escape', open_questions: 'Facts to be confirmed' },
  { key: 'sinabung', name: 'The R Villa Sinabung', area: 'Sanur', type: 'villa', guests: 4, size_m2: 150, bedrooms: '2', url: BASE + 'cozy-2br-the-r-villa-sinabung-w-pool-in-sanur-6d9d839b', highlights: 'Pool; Sanur beachside calm', open_questions: 'Facts to be confirmed' },
  { key: 'merapi', name: 'The R Villa Merapi (rooms)', area: 'Pererenan', type: 'room', guests: 2, size_m2: 35, bedrooms: 'private rooms', url: BASE + 'the-r-villa-merapi-0a1e5106', highlights: 'Rooms in The R Villa Merapi, 2 guests per room', open_questions: 'Elev8 lists 5 rooms of 2, Vrbo a 5-bedroom villa for 10. Confirm how it is sold' },
  { key: 'apartments', name: 'The R Apartments', area: 'Pererenan', type: 'apartment', guests: 3, bedrooms: 'studios and mezzanine apartments', url: 'https://www.elevate-villas.com', highlights: 'Studios and mezzanine apartments, some with balcony or plunge pool; walk to the beach', open_questions: 'Several units (apartments 1 to 11). Facts per unit to be confirmed' }
];

// Neighbourhood facts from elevate-villas.com. Posts about areas may only use these.
export const AREAS = {
  Pererenan: ['Surfing at Pererenan Beach', 'Rice paddy walks and sunrise trekking', 'Yoga and wellness retreat sessions', 'Local warungs and boutique cafes'],
  Canggu: ['Surfing at Echo Beach and Batu Bolong Beach', 'Sunset at Finn\'s Beach Club', 'The Canggu food and cafe scene', 'Cycling through rice terraces and local villages'],
  Sanur: ['Sunrise walk along the Sanur beach promenade', 'Snorkeling and day trips to Nusa Penida or Nusa Lembongan', 'The Blanco Renaissance Museum', 'Windsurfing and stand-up paddleboarding on calm waters']
};

export async function seedProperties() {
  for (const p of PROPERTIES) {
    await q(
      `insert into properties (key, name, area, type, guests, size_m2, bedrooms, url, highlights, open_questions, active)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (key) do nothing`,
      [p.key, p.name, p.area, p.type, p.guests ?? null, p.size_m2 ?? null, p.bedrooms ?? null, p.url, p.highlights ?? null, p.open_questions ?? null, p.active ?? true]
    );
  }
}
