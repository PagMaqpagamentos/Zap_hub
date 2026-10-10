import tempfile
import tkinter as tk
import unittest
from pathlib import Path
from unittest.mock import patch
from datetime import datetime, timezone, timedelta
import paratech_infinite as app

class WindowsTests(unittest.TestCase):
    def test_dpapi_and_atomic_storage(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory)
            with patch.object(app,"BASE",base),patch.object(app,"CONFIG",base/"hub.dat"):
                app.save_config({"token":"segredo-teste"})
                self.assertNotIn(b"segredo-teste",(base/"hub.dat").read_bytes())
                self.assertEqual(app.read_config()["token"],"segredo-teste")
    def test_setup_and_notices_fit(self):
        root=tk.Tk();root.withdraw()
        try:
            with patch.object(app,"read_config",return_value={}):hub=app.Hub(root)
            self.assertTrue(root.winfo_children())
            hub.config={"hubId":"test","installationId":"test","targets":[]}
            hub.lease={"expiresAt":(datetime.now(timezone.utc)+timedelta(hours=24)).isoformat(),"policy":"auto","forced":False,
                       "customer":"Cliente de demonstração","company":"Empresa de demonstração","blockDate":"2099-01-15","availableDate":"2026-01-01",
                       "invoice":{"id":"test","number":"TESTE-001","name":"Sistema de gestão","due":"2099-01-10","reference":"2099-01","balance":10000}}
            for status in ["available","overdue","blocked","offline-expired"]:
                hub.show_notice(status);root.update_idletasks()
                frame=hub.notice.winfo_children()[0]
                self.assertLessEqual(frame.winfo_reqheight(),650,status)
                self.assertLessEqual(frame.winfo_reqwidth(),610,status)
        finally:root.destroy()

if __name__=="__main__":unittest.main()
