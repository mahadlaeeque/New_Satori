import os, tempfile, types
os.environ.pop("CLOUD_SQL_CONNECTION_NAME", None)
os.environ.pop("SMTP_USER", None); os.environ.pop("SMTP_PASSWORD", None)
import database
database.DB_PATH=os.path.join(tempfile.gettempdir(),"pw.db")
if os.path.exists(database.DB_PATH): os.remove(database.DB_PATH)
import main, emailer
def show(n,c,extra=""): print(("PASS" if c else "FAIL"), n, ("- "+extra) if extra else "")
req=types.SimpleNamespace(client=types.SimpleNamespace(host="127.0.0.1"), headers={"user-agent":"t"}, base_url="https://satori-v2.example.app/")

show("emailer not configured -> (False, msg)", emailer.send_email("a@b.com","s","b")[0] is False)

# forgot for nonexistent email -> generic, no crash
r1=main.forgot_password(main.ForgotPasswordRequest(email="nobody@x.com"), req)
show("forgot unknown email -> generic", "registered" in r1["message"])

# forgot for the seeded superadmin -> generic + a token logged
import io, contextlib
buf=io.StringIO()
with contextlib.redirect_stdout(buf):
    r2=main.forgot_password(main.ForgotPasswordRequest(email="superadmin@tmc.com"), req)
out=buf.getvalue()
show("forgot known email -> generic (no leak)", "registered" in r2["message"] and "token" not in r2)
import re
m=re.search(r"reset\?token=([\w\.\-]+)", out)
show("reset link logged server-side", bool(m), "link present in logs" if m else "no link logged")
token=m.group(1) if m else ""

# reset with the token -> success, password becomes the new one
r3=main.reset_password(main.ResetPasswordRequest(token=token, new_password="newpass123"), req)
show("reset-password succeeds", "updated" in r3["message"])
# verify password changed
import bcrypt
db=main.get_db(); cur=db.cursor(); cur.execute("SELECT password FROM users WHERE email='superadmin@tmc.com'"); h=cur.fetchone()["password"]; db.close()
show("new password verifies", bcrypt.checkpw(b"newpass123", h.encode()))

# invalid / wrong-typ token rejected
try:
    main.reset_password(main.ResetPasswordRequest(token="garbage", new_password="abcdef"), req); show("garbage token rejected", False)
except main.HTTPException as e: show("garbage token rejected", e.status_code==400)
# short password rejected
try:
    main.reset_password(main.ResetPasswordRequest(token=token, new_password="x"), req); show("short pw rejected", False)
except main.HTTPException as e: show("short pw rejected", e.status_code==400)
# superadmin emails include the 2 new users
show("numair is superadmin email", "numair.mazhar@tmcltd.com" in main._SUPERADMIN_EMAILS)
show("mahad is superadmin email", "mahad.laeeque@tmcltd.com" in main._SUPERADMIN_EMAILS)
print("DONE")
