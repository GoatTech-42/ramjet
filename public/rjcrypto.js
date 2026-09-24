/* ramjet zero-knowledge sync crypto.
   KEK = PBKDF2-SHA256(password, salt, 250k) -> AES-GCM, non-extractable, kept in IndexedDB.
   dataKey = random AES-GCM-256, wrapped by KEK, stored inside the server blob.
   server only ever sees { v, salt, wk, iv, ct } - all ciphertext. */
"use strict";
const RJCrypto = (() => {
	const te = new TextEncoder(), td = new TextDecoder();
	const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
	const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

	function idb() {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open("rj-keys", 1);
			req.onupgradeneeded = () => req.result.createObjectStore("keys");
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}
	async function idbGet(name) {
		const db = await idb();
		return new Promise((resolve) => {
			const tx = db.transaction("keys", "readonly").objectStore("keys").get(name);
			tx.onsuccess = () => resolve(tx.result || null);
			tx.onerror = () => resolve(null);
		});
	}
	async function idbSet(name, val) {
		const db = await idb();
		return new Promise((resolve) => {
			const tx = db.transaction("keys", "readwrite").objectStore("keys").put(val, name);
			tx.onsuccess = () => resolve();
			tx.onerror = () => resolve();
		});
	}
	async function idbDel(name) {
		const db = await idb();
		return new Promise((resolve) => {
			const tx = db.transaction("keys", "readwrite").objectStore("keys").delete(name);
			tx.onsuccess = () => resolve();
			tx.onerror = () => resolve();
		});
	}

	async function deriveKEK(password, saltB64) {
		const salt = saltB64 ? unb64(saltB64) : crypto.getRandomValues(new Uint8Array(16));
		const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]);
		const kek = await crypto.subtle.deriveKey(
			{ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" },
			base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
		return { kek, saltB64: b64(salt) };
	}
	async function newDataKey() {
		return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
	}
	async function wrapDataKey(kek, dataKey) {
		const raw = await crypto.subtle.exportKey("raw", dataKey);
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, raw);
		return b64(iv) + "$" + b64(ct);
	}
	async function unwrapDataKey(kek, wk) {
		const [ivB, ctB] = wk.split("$");
		const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivB) }, kek, unb64(ctB));
		return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
	}
	async function encryptPayload(dataKey, obj) {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dataKey, te.encode(JSON.stringify(obj)));
		return b64(iv) + "$" + b64(ct);
	}
	async function decryptPayload(dataKey, payload) {
		const [ivB, ctB] = payload.split("$");
		const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivB) }, dataKey, unb64(ctB));
		return JSON.parse(td.decode(pt));
	}

	// session state (memory only)
	let dataKey = null, blobSalt = null;

	// after a fresh login with the password in hand. Returns true when a usable
	// key chain exists (existing blob unwrapped, or a brand new one made).
	async function unlockWithPassword(password) {
		const res = await fetch("/auth/sync");
		if (!res.ok) return false;
		const { blob } = await res.json();
		if (blob && blob.salt && blob.wk) {
			const { kek } = await deriveKEK(password, blob.salt);
			try { dataKey = await unwrapDataKey(kek, blob.wk); }
			catch { return false; } // password changed elsewhere; caller must reset
			await idbSet("kek", kek);
			blobSalt = blob.salt;
			return true;
		}
		// first run: fresh key chain
		const { kek, saltB64 } = await deriveKEK(password, null);
		dataKey = await newDataKey();
		const wk = await wrapDataKey(kek, dataKey);
		await idbSet("kek", kek);
		blobSalt = saltB64;
		await push({ history: [], bookmarks: [], settings: null });
		return true;
	}

	// on boot: try the IndexedDB KEK (no password prompt)
	async function tryRestore() {
		const kek = await idbGet("kek");
		if (!kek) return false;
		const res = await fetch("/auth/sync");
		if (!res.ok) return false;
		const { blob } = await res.json();
		if (!blob || !blob.wk) return false;
		try { dataKey = await unwrapDataKey(kek, blob.wk); } catch { return false; }
		blobSalt = blob.salt;
		return true;
	}

	async function pull() {
		if (!dataKey) {
			if (!(await tryRestore())) return null;
		}
		const res = await fetch("/auth/sync");
		if (!res.ok) return null;
		const { blob } = await res.json();
		if (!blob || !blob.ct) return { history: [], bookmarks: [], settings: null };
		try { return await decryptPayload(dataKey, blob.ct); } catch { return null; }
	}

	async function push(data) {
		if (!dataKey) return false;
		const res = await fetch("/auth/sync");
		const { blob } = res.ok ? await res.json() : {};
		const body = {
			v: 1,
			salt: blobSalt || (blob && blob.salt),
			wk: blob && blob.wk ? blob.wk : await wrapDataKey(await idbGet("kek"), dataKey),
			ct: await encryptPayload(dataKey, data),
		};
		const put = await fetch("/auth/sync", {
			method: "PUT",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "blob=" + encodeURIComponent(JSON.stringify(body)),
		});
		return put.ok;
	}

	async function changePassword(oldPw, newPw) {
		// re-wrap the same data key under a new KEK, then rotate the login hash
		const res = await fetch("/auth/sync");
		const { blob } = res.ok ? await res.json() : {};
		if (!dataKey && blob && blob.wk) {
			const { kek } = await deriveKEK(oldPw, blob.salt);
			try { dataKey = await unwrapDataKey(kek, blob.wk); } catch { return { ok: false, error: "current password wrong" }; }
		}
		if (!dataKey) dataKey = await newDataKey();
		const fresh = await deriveKEK(newPw, null);
		const wk = await wrapDataKey(fresh.kek, dataKey);
		const cur = await pull() || { history: [], bookmarks: [], settings: null };
		const ct = await encryptPayload(dataKey, cur);
		const pw = await fetch("/auth/passwd", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "old=" + encodeURIComponent(oldPw) + "&new=" + encodeURIComponent(newPw),
		});
		if (!pw.ok) return { ok: false, error: (await pw.json()).error || "password change failed" };
		await fetch("/auth/sync", {
			method: "PUT",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "blob=" + encodeURIComponent(JSON.stringify({ v: 1, salt: fresh.saltB64, wk, ct })),
		});
		await idbSet("kek", fresh.kek);
		blobSalt = fresh.saltB64;
		return { ok: true };
	}

	async function lock() {
		dataKey = null; blobSalt = null;
		await idbDel("kek");
	}
	const unlocked = () => !!dataKey;
	return { unlockWithPassword, tryRestore, pull, push, changePassword, lock, unlocked };
})();
