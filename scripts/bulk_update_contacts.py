#!/usr/bin/env python3
"""Bulk update prospect contact info from web search results."""
import json

PROSPECTS_FILE = '/opt/cottage/data/prospects.json'

# All found contact info from 4 search batches, keyed by business name (lowercase)
UPDATES = {
    # Batch A
    "bake n' bloom": {"instagram": "@bakenbloom"},
    "barrio bites llc": {"email": "info@barriobitesla.com", "phone": "917-504-1140", "instagram": "@barriobites.la", "website": "https://barriobitesla.com"},
    "baylei's comfort kitchen": {"instagram": "@chefbaylei_"},
    "club 051": {"instagram": "@club.051"},
    "erkitchen.com": {"email": "info@erkitchen.com", "phone": "(323) 362-2263", "instagram": "@erkitchenhome", "website": "https://erkitchen.com"},
    "granada": {"phone": "(323) 379-2573", "instagram": "@granadacoffeeco", "website": "https://granada-la.com"},
    "kafou alkaline foods": {"website": "https://kafoustore.com"},
    "karak corner": {"phone": "(747) 347-6848", "instagram": "@karakcorner_"},

    # Batch B
    "little city farm": {"instagram": "@littlecityfarmla", "website": "https://littlecityfarmla.com"},
    "mama chila": {"phone": "(323) 891-6488"},
    "mama glendas": {"website": "https://mamaglendaskitchen.com"},
    "not your mom's pies": {"instagram": "@notyourmomsfoods", "website": "https://notyourmomspies.com"},
    "serve coffee + pastries": {"instagram": "@serve.pastries", "website": "https://hotplate.com/serve"},
    "smoke city bbq la": {"phone": "(323) 505-2982", "instagram": "@smokecitybbqla", "website": "https://smokecitybbqla.com"},
    "smoke mo's la": {"phone": "213-308-4951", "instagram": "@smokeymos.la"},
    "thai rama kitchen": {"email": "thairamaonglendale@gmail.com", "phone": "(818) 545-8424", "website": "https://thairamatogo.com"},
    "neighborhood coffee": {"phone": "(323) 413-2531", "website": "https://neighborhoodcoffeeshop.com"},
    "mediterranean home kitch": {"phone": "(408) 680-9265"},

    # Batch C
    "vendittis pizza": {"website": "https://vendittispizza.com"},
    "yana's ladas": {"phone": "(323) 822-8968", "website": "https://yanasladas.info"},
    "reni coffee": {"instagram": "@reni_coffee"},
    "tom's burgers and bowls": {"phone": "(626) 380-8000", "website": "https://626tomsburger.com"},

    # Batch D
    "favor&flavor afriq llc": {"email": "eghann90@gmail.com", "phone": "(323) 407-0650", "instagram": "@favorflavorllc", "website": "https://flavornania.com"},
    "gorditas laguneras": {"phone": "(909) 955-5325", "instagram": "@gorditaslaguneras"},
    "jajah omah": {"email": "info@jajanomah.com", "phone": "(424) 448-9053", "instagram": "@jajanomah_la", "website": "https://jajanomah.com"},
    "minon cake": {"phone": "(213) 537-0985", "instagram": "@minoncake"},
    "montero yogurt": {"instagram": "@montero_yogurt"},
    "nawal": {"instagram": "@nawal_losangeles"},
    "tao's kitchen": {"phone": "(626) 288-9966", "website": "https://taoskitchenca.com"},
    "watts q": {"email": "orders@wattsq.com", "phone": "(310) 874-9607", "instagram": "@WattsQ.LA", "website": "https://wattsq.com"},
    "chef g french cuisine": {"phone": "(626) 818-9424", "instagram": "@chef_g_french_cuisine"},
    "frenican bakes": {"email": "FrenicanBakes@gmail.com", "instagram": "@frenicanbakes", "website": "https://frenicanbakes.com"},
    "kindred toffee x gsoul mini kitchen": {"email": "kindredtoffee@gmail.com", "phone": "(818) 960-8510", "instagram": "@KINDREDTOFFEE", "website": "https://kindredtoffee.com"},
}

data = json.load(open(PROSPECTS_FILE))
updated = 0

for p in data['prospects']:
    name = (p.get('businessName') or p.get('name') or '').strip().lower()

    # Try exact match first, then partial
    update = UPDATES.get(name)
    if not update:
        for key, val in UPDATES.items():
            if key in name or name in key:
                update = val
                break

    if update:
        changed = False
        for field in ['email', 'phone', 'instagram', 'website']:
            if field in update and (not p.get(field) or not p[field].strip()):
                p[field] = update[field]
                changed = True
        if changed:
            updated += 1
            print(f"Updated: {p.get('businessName', p.get('name', '?'))} -> {update}")

with open(PROSPECTS_FILE, 'w') as f:
    json.dump(data, f, indent=2)

# Final stats
total = len(data['prospects'])
has_email = sum(1 for p in data['prospects'] if p.get('email', '').strip())
has_phone = sum(1 for p in data['prospects'] if p.get('phone', '').strip())
has_ig = sum(1 for p in data['prospects'] if p.get('instagram', '').strip())
has_website = sum(1 for p in data['prospects'] if p.get('website', '').strip())
has_any = sum(1 for p in data['prospects'] if p.get('email', '').strip() or p.get('phone', '').strip() or p.get('instagram', '').strip())
has_nothing = sum(1 for p in data['prospects'] if not p.get('email', '').strip() and not p.get('phone', '').strip() and not p.get('instagram', '').strip() and not p.get('website', '').strip())

print(f"\n=== FINAL STATS ===")
print(f"Updated: {updated} prospects")
print(f"Total: {total}")
print(f"Has email: {has_email}")
print(f"Has phone: {has_phone}")
print(f"Has Instagram: {has_ig}")
print(f"Has website: {has_website}")
print(f"Has ANY contact (email/phone/IG): {has_any}")
print(f"Has NOTHING: {has_nothing}")
