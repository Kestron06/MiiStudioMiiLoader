const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'popup', 'popup.js'), 'utf8');
const pageUrl = 'https://studio.mii.nintendo.com/miis/1234567890abcdef/edit?client_id=abcdef1234567890&extra=1';
const canonicalUrl = pageUrl.slice(0, pageUrl.indexOf('&extra='));
const exactKey = encodeURIComponent(pageUrl);
const canonicalKey = encodeURIComponent(canonicalUrl);

function makeHarness({ initial = {}, canvas = null } = {}) {
	const values = new Map(Object.entries(initial));
	const calls = [];
	const context = vm.createContext({
		URL,
		location: { href: pageUrl },
		localStorage: {
			getItem: key => values.get(key) ?? null,
			setItem: (key, value) => values.set(key, value)
		},
		document: {
			readyState: 'loading',
			addEventListener() {},
			getElementById: () => ({ addEventListener() {} }),
			querySelector: () => canvas
		},
		chrome: {
			scripting: {
				executeScript: async options => {
					calls.push(options);
					return [{ result: await options.func(...options.args) }];
				}
			}
		},
		console,
		setTimeout: callback => callback()
	});
	vm.runInContext(`${source}\nglobalThis.testAPI = { getPageLocalStorage, recoverPageMiiData }; currentTab = { id: 7 };`, context);
	return { values, calls, api: context.testAPI };
}

test('reads the editor exact URL key before the older canonical key', async () => {
	const harness = makeHarness({ initial: { [exactKey]: 'current', [canonicalKey]: 'old' } });
	const result = await harness.api.getPageLocalStorage(canonicalKey);
	assert.equal(result.key, exactKey);
	assert.equal(result.data, 'current');
});

test('saves the unchanged editor Mii when local storage is missing', async () => {
	const mii = { name: 'Current Mii' };
	let updates = 0;
	const editor = {
		isPartsPage: true,
		history: { current: mii },
		onPartsUpdated(value) {
			assert.equal(value, mii);
			updates++;
			harness.values.set(exactKey, 'encoded-current-mii');
		}
	};
	const canvas = { parentElement: { __vue__: editor, parentElement: null } };
	const harness = makeHarness({ canvas });
	const result = await harness.api.recoverPageMiiData(canonicalKey);
	assert.equal(result.key, exactKey);
	assert.equal(result.data, 'encoded-current-mii');
	assert.equal(updates, 1);
	assert.equal(harness.calls[0].world, 'MAIN');
});

test('does not update the editor when data already exists', async () => {
	let updates = 0;
	const editor = {
		isPartsPage: true,
		history: { current: {} },
		onPartsUpdated() { updates++; }
	};
	const canvas = { __vue__: editor, parentElement: null };
	const harness = makeHarness({ canvas, initial: { [exactKey]: 'existing' } });
	const result = await harness.api.recoverPageMiiData(canonicalKey);
	assert.equal(result.data, 'existing');
	assert.equal(updates, 0);
});
