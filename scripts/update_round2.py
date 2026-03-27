import json

PROSPECTS_FILE = '/opt/cottage/data/prospects.json'

NEW_EMAILS = {
    "sahani delight kitchen": "betty@sahanidelightkitchen.com",
    "socal pie co": "socalpieco@gmail.com",
    "nikkimomo": "monique@nikkimomo.com",
    "not yo mama's tacos": "chefana@notyomamastacos.com",
    "sunday salt": "claudiamcneilly@gmail.com",
}

data = json.load(open(PROSPECTS_FILE))
updated = 0

for p in data['prospects']:
    if p.get('email', '').strip():
        continue
    name = (p.get('businessName') or p.get('name') or '').strip().lower()
    for key, email in NEW_EMAILS.items():
        if key in name or name in key:
            p['email'] = email
            updated += 1
            print(f"Updated: {p.get('businessName', p.get('name', '?'))} -> {email}")
            break

with open(PROSPECTS_FILE, 'w') as f:
    json.dump(data, f, indent=2)

has_email = sum(1 for p in data['prospects'] if p.get('email', '').strip())
print(f"\nUpdated: {updated}")
print(f"Total with email: {has_email} / {len(data['prospects'])}")
