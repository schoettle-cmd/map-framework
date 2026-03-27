import json

d = json.load(open("/opt/cottage/data/prospects.json"))
ps = d["prospects"]

has_email = sum(1 for p in ps if p.get("email","").strip())
has_phone = sum(1 for p in ps if p.get("phone","").strip())
has_ig = sum(1 for p in ps if p.get("instagram","").strip())
has_website = sum(1 for p in ps if p.get("website","").strip())
has_any = sum(1 for p in ps if p.get("email","").strip() or p.get("phone","").strip() or p.get("instagram","").strip())
has_nothing = sum(1 for p in ps if not p.get("email","").strip() and not p.get("phone","").strip() and not p.get("instagram","").strip() and not p.get("website","").strip())

print(f"Total: {len(ps)}")
print(f"Has email: {has_email}")
print(f"Has phone: {has_phone}")
print(f"Has Instagram: {has_ig}")
print(f"Has website: {has_website}")
print(f"Has ANY contact (email/phone/IG): {has_any}")
print(f"Has NOTHING (no email, phone, IG, or website): {has_nothing}")
print()

no_email = [p for p in ps if not p.get("email","").strip()]
no_email_has_ig = sum(1 for p in no_email if p.get("instagram","").strip())
no_email_has_phone = sum(1 for p in no_email if p.get("phone","").strip())
no_email_has_website = sum(1 for p in no_email if p.get("website","").strip())
no_email_only_address = sum(1 for p in no_email if not p.get("instagram","").strip() and not p.get("phone","").strip() and not p.get("website","").strip())

print(f"Missing email ({len(no_email)}):")
print(f"  ...but have Instagram: {no_email_has_ig}")
print(f"  ...but have phone: {no_email_has_phone}")
print(f"  ...but have website: {no_email_has_website}")
print(f"  ...have ONLY address: {no_email_only_address}")
print()

# List the ones with absolutely nothing
print("=== Prospects with ONLY an address (no email, phone, IG, website) ===")
for p in ps:
    if not p.get("email","").strip() and not p.get("phone","").strip() and not p.get("instagram","").strip() and not p.get("website","").strip():
        name = p.get("businessName", p.get("name", "?"))
        addr = p.get("address", "?")
        neighborhood = p.get("neighborhood", "")
        print(f"  {name} | {neighborhood} | {addr}")
