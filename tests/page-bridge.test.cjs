const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content', 'page-bridge.js'), 'utf8');
const hydrateSource = fs.readFileSync(path.join(__dirname, '..', 'content', 'hydrate.js'), 'utf8');
const REQUEST = 'mii-studio-mii-loader:page';
const EDIT_URL = 'https://studio.mii.nintendo.com/miis/0123456789abcdef/edit?client_id=abcdef0123456789';

test('the popup uses the page bridge without temporary tab access or script injection', () => {
	const root = path.join(__dirname, '..');
	const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
	const popup = fs.readFileSync(path.join(root, 'popup', 'popup.js'), 'utf8');
	assert.ok(!manifest.permissions?.includes('activeTab'));
	assert.ok(!manifest.permissions?.includes('scripting'));
	assert.doesNotMatch(popup, /chrome\.scripting\./);
	assert.doesNotMatch(popup, /(?:currentTab|tab)\?*\.url\b/);
	assert.match(popup, /chrome\.tabs\.sendMessage\(/);
});

function makePage(url, initialItems = {}, onHydrate = () => {}) {
	const items = new Map(Object.entries(initialItems));
	const eventListeners = new Map();
	let listener;
	let hydrationRequests = 0;
	const document = {
		addEventListener(type, callback) {
			if (!eventListeners.has(type)) eventListeners.set(type, new Set());
			eventListeners.get(type).add(callback);
		},
		removeEventListener(type, callback) {
			eventListeners.get(type)?.delete(callback);
		},
		dispatchEvent(event) {
			if (event.type === 'mii-studio-mii-loader:hydrate-request') {
				hydrationRequests++;
				onHydrate(items);
			}
			for (const callback of eventListeners.get(event.type) ?? []) callback(event);
			return true;
		}
	};
	const context = {
		chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
		console,
		document,
		Event: class Event { constructor(type) { this.type = type; } },
		location: new URL(url),
		localStorage: {
			getItem(key) { return items.get(key) ?? null; },
			setItem(key, value) { items.set(key, String(value)); }
		},
		setTimeout: (callback) => setTimeout(callback, 0),
		URL
	};
	vm.runInNewContext(source, context, { filename: 'content/page-bridge.js' });
	assert.equal(typeof listener, 'function', 'the bridge must register a runtime message listener');
	return {
		items,
		get hydrationRequests() { return hydrationRequests; },
		message(request) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('bridge did not respond')), 1000);
				const respond = response => {
					clearTimeout(timer);
					resolve(response);
				};
				listener({ type: REQUEST, ...request }, {}, respond);
			});
		}
	};
}

test('read reports the new-Mii page and other unsupported pages', async () => {
	assert.equal((await makePage('https://studio.mii.nintendo.com/miis/new').message({ action: 'read' })).status, 'new');
	assert.equal((await makePage('https://studio.mii.nintendo.com/').message({ action: 'read' })).status, 'wrong-page');
	assert.equal((await makePage('https://example.com/miis/new').message({ action: 'read' })).status, 'wrong-page');
});

test('read distinguishes an incomplete editor URL from unavailable Mii data', async () => {
	assert.equal((await makePage('https://studio.mii.nintendo.com/miis/bad/edit?client_id=abcdef0123456789').message({ action: 'read' })).status, 'missing-id');
	assert.equal((await makePage('https://studio.mii.nintendo.com/miis/0123456789abcdef/edit').message({ action: 'read' })).status, 'missing-id');
	assert.equal((await makePage(EDIT_URL).message({ action: 'read' })).status, 'missing-data');
});

test('read returns the current exact localStorage entry before a canonical fallback', async () => {
	const url = `${EDIT_URL}#parts`;
	const exactKey = encodeURIComponent(url);
	const canonicalKey = encodeURIComponent(EDIT_URL);
	const page = makePage(url, { [exactKey]: 'exact-data', [canonicalKey]: 'old-data' });
	const result = await page.message({ action: 'read' });
	assert.equal(result.status, 'ready');
	assert.equal(result.key, exactKey);
	assert.equal(result.data, 'exact-data');
	assert.equal(page.hydrationRequests, 0);
});

test('read accepts a canonical editor key when the current URL has extra parameters', async () => {
	const canonicalKey = encodeURIComponent(EDIT_URL);
	const page = makePage(`${EDIT_URL}&view=parts`, { [canonicalKey]: 'canonical-data' });
	const result = await page.message({ action: 'read' });
	assert.equal(result.status, 'ready');
	assert.equal(result.key, canonicalKey);
	assert.equal(result.data, 'canonical-data');
	assert.equal(page.hydrationRequests, 0);
});

test('read recovers missing Mii data through the editor hydration event', async () => {
	const key = encodeURIComponent(EDIT_URL);
	const page = makePage(EDIT_URL, {}, items => items.set(key, 'recovered-data'));
	const result = await page.message({ action: 'read' });
	assert.equal(result.status, 'ready');
	assert.equal(result.key, key);
	assert.equal(result.data, 'recovered-data');
	assert.ok(page.hydrationRequests > 0);
});

test('write stores data only under the current editor key', async () => {
	const key = encodeURIComponent(EDIT_URL);
	const page = makePage(EDIT_URL);
	assert.equal((await page.message({ action: 'write', key, value: '001122' })).status, 'written');
	assert.equal(page.items.get(key), '001122');
	assert.equal((await page.message({ action: 'write', key: encodeURIComponent('https://example.com/'), value: 'bad' })).status, 'invalid-key');
	assert.equal(page.items.size, 1);
	assert.equal((await makePage('https://studio.mii.nintendo.com/miis/new').message({ action: 'write', key, value: 'bad' })).status, 'wrong-page');
});

function makeHydrationPage(editor) {
	const key = encodeURIComponent(EDIT_URL);
	const items = new Map();
	const listeners = new Map();
	const resultDetails = [];
	const document = {
		querySelector(selector) {
			assert.equal(selector, 'canvas#canvas');
			return editor ? { __vue__: editor, parentElement: null } : null;
		},
		addEventListener(type, callback) { listeners.set(type, callback); },
		dispatchEvent(event) {
			if (event.type === 'mii-studio-mii-loader:hydrate-result') resultDetails.push(event.detail);
			else listeners.get(event.type)?.(event);
		}
	};
	vm.runInNewContext(hydrateSource, {
		console,
		document,
		location: new URL(EDIT_URL),
		localStorage: { getItem: itemKey => items.get(itemKey) ?? null },
		CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options.detail; } }
	}, { filename: 'content/hydrate.js' });
	assert.equal(typeof listeners.get('mii-studio-mii-loader:hydrate-request'), 'function');
	return { document, items, key, resultDetails };
}

test('the MAIN-world hydration hook asks the active Vue editor to save its Mii', () => {
	let updates = 0;
	const editor = {
		isPartsPage: true,
		history: { current: { face: 'current Mii' } },
		onPartsUpdated(parts) {
			updates++;
			assert.equal(parts, this.history.current);
			page.items.set(page.key, '0123456789abcdef');
		}
	};
	const page = makeHydrationPage(editor);
	page.document.dispatchEvent({ type: 'mii-studio-mii-loader:hydrate-request' });
	assert.equal(updates, 1);
	assert.equal(page.items.get(page.key), '0123456789abcdef');
	assert.deepEqual(page.resultDetails, ['hydrated']);
});

test('the MAIN-world hydration hook reports when there is no active editor', () => {
	const page = makeHydrationPage(null);
	page.document.dispatchEvent({ type: 'mii-studio-mii-loader:hydrate-request' });
	assert.equal(page.items.size, 0);
	assert.deepEqual(page.resultDetails, ['unavailable']);
});

test('the MAIN-world hydration hook tries once and reports when the editor writes no data', () => {
	let updates = 0;
	const page = makeHydrationPage({
		isPartsPage: true,
		history: { current: { face: 'current Mii' } },
		onPartsUpdated() { updates++; }
	});
	page.document.dispatchEvent({ type: 'mii-studio-mii-loader:hydrate-request' });
	assert.equal(updates, 1);
	assert.equal(page.items.size, 0);
	assert.deepEqual(page.resultDetails, ['no-data']);
});
