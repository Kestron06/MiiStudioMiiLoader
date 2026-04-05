let loadingDiv;
let notValidURLDiv;
let miiStudioDiv;
let miiStudioNoMiiIDOrClientIDWarningDiv;
let miiStudioNoMiiDataWarningDiv;
let miiStudioContentDiv;
let miiStudioMiiDataDiv;
let newMiiStudioDataInput;
let updateMiiStudioDataButton;

let currentTab;

let miiStudioMiiID;
let miiStudioClientID;
let miiStudioStorageKey;
let miijs;
let exportFormatDropdown;
let exportFormatButton;
let exportFormatSearchInput;
let exportFormatPanel;
let exportFormatOptionsContainer;
let exportFormatSelect;
let exportFormatOptions = [];

const MII_STUDIO_URL_REGEX = /https:\/\/studio\.mii\.nintendo\.com\/miis\/([a-f0-9]{16})\/edit\?client_id=([a-f0-9]{16})/;
const IS_HEX_REGEX = /^[a-f\d\s]+$/i;
const IS_B64_REGEX = /^((([a-z\d+/]{4})*)([a-z\d+/]{4}|[a-z\d+/]{3}=|[a-z\d+/]{2}==))$/i;

let miijsPromise;

async function getMiijs() {
	if (!miijsPromise) {
		miijsPromise = import(chrome.runtime.getURL('miijs.browser.js'))
			.then(module => module.default)
			.catch(error => {
				console.error('Failed to load miijs.browser.js', error);
				throw error;
			});
	}

	return miijsPromise;
}

async function getCurrentTab() {
	const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
	return tabs[0];
}

async function getPageLocalStorage(key) {
	const response = await chrome.scripting.executeScript({
		args: [key],
		target: {
			tabId: currentTab.id
		},
		func: function(key) {
			return localStorage.getItem(key);
		}
	});

	return response[0]?.result;
}

async function setPageLocalStorage(key, value) {
	await chrome.scripting.executeScript({
		args: [key, value],
		target: {
			tabId: currentTab.id
		},
		func: function(key, value) {
			localStorage.setItem(key, value);
		}
	});
}

function normaliseDropdownFilterText(text) {
	return text
		.toLowerCase()
		.replaceAll('/', ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function closeExportFormatDropdown({ resetFilter = true } = {}) {
	if (!exportFormatPanel || !exportFormatButton) {
		return;
	}

	exportFormatPanel.hidden = true;
	exportFormatButton.setAttribute('aria-expanded', 'false');

	if (resetFilter && exportFormatSearchInput) {
		exportFormatSearchInput.value = '';
	}
}

function setSelectedExportFormat(value) {
	if (!exportFormatSelect || !exportFormatButton) {
		return;
	}

	const selectedOption = Array.from(exportFormatSelect.options).find(option => option.value === value);
	if (!selectedOption) {
		return;
	}

	exportFormatSelect.value = selectedOption.value;
	exportFormatButton.textContent = selectedOption.textContent;
}

function renderExportFormatOptions(filterText = '') {
	if (!exportFormatSelect || !exportFormatOptionsContainer) {
		return;
	}

	const currentValue = exportFormatSelect.value;
	const normalisedFilter = normaliseDropdownFilterText(filterText);
	const matchingOptions = exportFormatOptions.filter(option => {
		if (!normalisedFilter) {
			return true;
		}

		return normaliseDropdownFilterText(option.text).includes(normalisedFilter);
	});

	exportFormatOptionsContainer.replaceChildren();

	if (matchingOptions.length === 0) {
		const emptyState = document.createElement('div');
		emptyState.className = 'searchable-select-empty';
		emptyState.textContent = 'No formats found.';
		exportFormatOptionsContainer.appendChild(emptyState);
		return;
	}

	for (const option of matchingOptions) {
		const optionElement = document.createElement('button');
		optionElement.type = 'button';
		optionElement.className = 'searchable-select-option';
		if (option.value === currentValue) {
			optionElement.classList.add('is-selected');
		}
		optionElement.textContent = option.text;
		optionElement.dataset.value = option.value;
		optionElement.setAttribute('role', 'option');
		optionElement.setAttribute('aria-selected', option.value === currentValue ? 'true' : 'false');
		optionElement.addEventListener('click', () => {
			setSelectedExportFormat(option.value);
			closeExportFormatDropdown();
		});
		exportFormatOptionsContainer.appendChild(optionElement);
	}
}

function initExportFormatSearch() {
	exportFormatDropdown = document.getElementById('export-format-dropdown');
	exportFormatButton = document.getElementById('export-format-button');
	exportFormatSearchInput = document.getElementById('export-format-search');
	exportFormatPanel = document.getElementById('export-format-panel');
	exportFormatOptionsContainer = document.getElementById('export-format-options');
	exportFormatSelect = document.getElementById('export-format-select');

	if (!exportFormatDropdown || !exportFormatButton || !exportFormatSearchInput || !exportFormatPanel || !exportFormatOptionsContainer || !exportFormatSelect) {
		return;
	}

	exportFormatOptions = Array.from(exportFormatSelect.options).map(option => ({
		text: option.textContent,
		value: option.value
	}));

	setSelectedExportFormat(exportFormatSelect.value);
	renderExportFormatOptions();

	exportFormatButton.addEventListener('click', () => {
		const isOpening = exportFormatPanel.hidden;
		if (!isOpening) {
			closeExportFormatDropdown();
			return;
		}

		exportFormatPanel.hidden = false;
		exportFormatButton.setAttribute('aria-expanded', 'true');
		exportFormatSearchInput.value = '';
		renderExportFormatOptions();
		setTimeout(() => {
			exportFormatSearchInput.focus();
		}, 0);
	});

	exportFormatSearchInput.addEventListener('input', event => {
		renderExportFormatOptions(event.target.value);
	});

	exportFormatSearchInput.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			closeExportFormatDropdown();
			exportFormatButton.focus();
		}
	});

	document.addEventListener('click', event => {
		if (!exportFormatDropdown.contains(event.target)) {
			closeExportFormatDropdown();
		}
	});
}

document.addEventListener('DOMContentLoaded', async () => {
	loadingDiv = document.querySelector('#loading');
	notValidURLDiv = document.querySelector('#not-valid-url');
	initExportFormatSearch();

	try {
		miijs = await getMiijs();
	}
	catch (error) {
		console.error('miijs is unavailable in popup.js', error);
	}

	currentTab = await getCurrentTab();

	loadingDiv.hidden=true;

	if (!MII_STUDIO_URL_REGEX.test(currentTab.url)) {
		notValidURLDiv.hidden=false;
		return;
	}

	initMiiStudio();
});

async function initMiiStudio() {
	miiStudioDiv = document.querySelector('#mii-studio');
	miiStudioNoMiiIDOrClientIDWarningDiv = miiStudioDiv.querySelector('#no-mii-id-or-client-id');
	miiStudioNoMiiDataWarningDiv = miiStudioDiv.querySelector('#no-mii-data-warning');
	miiStudioContentDiv = miiStudioDiv.querySelector('.content');
	miiStudioMiiDataDiv = miiStudioContentDiv.querySelector('#mii-data');
	newMiiStudioDataInput = miiStudioContentDiv.querySelector('#new-mii-studio-data');
	updateMiiStudioDataButton = miiStudioContentDiv.querySelector('#update-mii-studio-data');

	miiStudioDiv.hidden=false;

	const regexResult = MII_STUDIO_URL_REGEX.exec(currentTab.url);

	if (regexResult.length !== 3) {
		miiStudioNoMiiIDOrClientIDWarningDiv.hidden=false;
		return;
	}

	miiStudioMiiID = regexResult[1];
	miiStudioClientID = regexResult[2];
	miiStudioStorageKey = `https%3A%2F%2Fstudio.mii.nintendo.com%2Fmiis%2F${miiStudioMiiID}%2Fedit%3Fclient_id%3D${miiStudioClientID}`;

	const miiData = await getPageLocalStorage(miiStudioStorageKey);

	if (!miiData) {
		miiStudioNoMiiDataWarningDiv.hidden=false;
		return;
	}

	miiStudioContentDiv.hidden=false;

	miiStudioMiiDataDiv.innerHTML = miiData;
	updateMiiStudioDataButton.addEventListener('click', updateMiiStudioData);
}

async function updateMiiStudioData() {
	let newMiiData = newMiiStudioDataInput.value;

	if(newMiiData && !IS_HEX_REGEX.test(newMiiData) && IS_B64_REGEX.test(newMiiData)){
		newMiiData=Uint8Array.from(atob(newMiiData), c => c.charCodeAt(0));
  		newMiiData=Array.from(newMiiData, b => b.toString(16).padStart(2, "0")).join("");
	}

	if (!newMiiData || !IS_HEX_REGEX.test(newMiiData)) {
		alert('Invalid Mii Data');
		return;
	}

	await setPageLocalStorage(miiStudioStorageKey, newMiiData);

	alert('Accept the reload and click "Continue editing" after the page reloads');

	chrome.tabs.reload(currentTab.id);
}

document.getElementById("copyHex").addEventListener('click',()=>{
	navigator.clipboard.writeText(miiStudioMiiDataDiv.innerText);
});
document.getElementById("copyB64").addEventListener('click',()=>{
	let copied=new Uint8Array(
		miiStudioMiiDataDiv.innerText.match(/.{1,2}/g).map(byte => parseInt(byte, 16))
	);
	copied=btoa(String.fromCharCode(...copied));
	navigator.clipboard.writeText(copied);
});

document.getElementById("impFile").addEventListener('click',async ()=>{
	const inputFile = document.getElementById("fileInp").files?.[0];
	if (!inputFile || !miijs) {
		return;
	}

	try {
		let decodedInput = new Uint8Array(await inputFile.arrayBuffer());
		const isImageFile = inputFile.type.startsWith('image/')
			|| /\.(png|jpe?g)$/i.test(inputFile.name);

		if (isImageFile) {
			const scannedMii = await miijs.scanQR(inputFile);
			if (!scannedMii) {
				throw new Error('MiiJS could not decode a QR from the selected image.');
			}
			decodedInput = scannedMii;
		}

		const decodedMii = miijs.decodeMii(decodedInput);
		const studioMiiData = miijs.encodeMii(decodedMii, miijs.MiiFormats.MNMS).toString('hex');
		newMiiStudioDataInput.value = studioMiiData;
		updateMiiStudioDataButton.click();
	}
	catch (error) {
		console.error('Failed to decode uploaded Mii file', error);
	}
});
