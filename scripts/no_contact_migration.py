#!/usr/bin/env python3
"""Move prospects with no contact info to 'no_contact' status and deactivate their map elements."""
import json

PROSPECTS_FILE = '/opt/cottage/data/prospects.json'
ELEMENTS_FILE = '/opt/cottage/data/elements.json'

data = json.load(open(PROSPECTS_FILE))
elements_data = json.load(open(ELEMENTS_FILE))

moved = 0
deactivated = 0

for p in data['prospects']:
    has_email = bool(p.get('email', '').strip())
    has_phone = bool(p.get('phone', '').strip())
    has_ig = bool(p.get('instagram', '').strip())

    if not has_email and not has_phone and not has_ig:
        old_status = p.get('status', '?')
        p['status'] = 'no_contact'
        moved += 1
        name = p.get('businessName', p.get('name', '?'))

        # Deactivate their map element if they have one
        pid = p.get('id', '')
        for el in elements_data['elements']:
            if el.get('metadata', {}).get('prospectId') == pid:
                if el.get('active', True) != False:
                    el['active'] = False
                    deactivated += 1
                break

        print(f"  {name} ({old_status} -> no_contact)")

with open(PROSPECTS_FILE, 'w') as f:
    json.dump(data, f, indent=2)

with open(ELEMENTS_FILE, 'w') as f:
    json.dump(elements_data, f, indent=2)

# Stats
statuses = {}
for p in data['prospects']:
    s = p.get('status', 'unknown')
    statuses[s] = statuses.get(s, 0) + 1

active_elements = sum(1 for e in elements_data['elements'] if e.get('active', True) != False)

print(f"\n=== RESULTS ===")
print(f"Moved to no_contact: {moved}")
print(f"Map elements deactivated: {deactivated}")
print(f"\nStatus breakdown:")
for s, c in sorted(statuses.items(), key=lambda x: -x[1]):
    print(f"  {s}: {c}")
print(f"\nActive map elements: {active_elements} / {len(elements_data['elements'])}")
