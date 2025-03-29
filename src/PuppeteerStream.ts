import {
	launch as puppeteerLaunch,
	LaunchOptions,
	Browser,
	Page,
	BrowserLaunchArgumentOptions,
	BrowserConnectOptions,
} from "puppeteer-core";
import * as path from "path";

const extensionId = "jjndjgheafjngoipoacpjgeicjeomjli";
type StreamLaunchOptions = LaunchOptions &
	BrowserLaunchArgumentOptions &
	BrowserConnectOptions & {
		allowIncognito?: boolean;
	} & {
		closeDelay?: number;
	} & {
		extensionPath?: string;
	};
let port: number;

export async function launch(
	arg1: StreamLaunchOptions | { launch?: Function;[key: string]: any },
	opts?: StreamLaunchOptions
): Promise<Browser> {
	//if puppeteer library is not passed as first argument, then first argument is options
	// @ts-ignore
	if (typeof arg1.launch != "function") opts = arg1;

	if (!opts) opts = {};
	if (!opts.args) opts.args = [];

	function addToArgs(arg: string, value?: string) {
		if (!value) {
			if (opts.args.includes(arg)) return;
			return opts.args.push(arg);
		}
		let found = false;
		opts.args = opts.args.map((x) => {
			if (x.includes(arg)) {
				found = true;
				return x + "," + value;
			}
			return x;
		});
		if (!found) opts.args.push(arg + value);
	}

	if (!opts.extensionPath) {
		opts.extensionPath = path.join(__dirname, "..", "extension");
	}

	addToArgs("--load-extension=", opts.extensionPath);
	addToArgs("--disable-extensions-except=", opts.extensionPath);
	addToArgs("--allowlisted-extension-id=", extensionId);
	addToArgs("--autoplay-policy=no-user-gesture-required");
	addToArgs("--auto-accept-this-tab-capture");

	if (opts.defaultViewport?.width && opts.defaultViewport?.height) {
		opts.args.push(`--window-size=${opts.defaultViewport.width},${opts.defaultViewport.height}`);
		opts.args.push(`--ozone-override-screen-size=${opts.defaultViewport.width},${opts.defaultViewport.height}`);
	}

	// @ts-ignore
	opts.headless = opts.headless === "new" ? "new" : false;

	if (opts.headless) {
		if (!opts.ignoreDefaultArgs) opts.ignoreDefaultArgs = [];

		if (Array.isArray(opts.ignoreDefaultArgs) && !opts.ignoreDefaultArgs.includes("--mute-audio"))
			opts.ignoreDefaultArgs.push("--mute-audio");

		if (!opts.args.includes("--headless=new")) opts.args.push("--headless=new");
	}

	let browser: Browser;

	// @ts-ignore
	if (typeof arg1.launch == "function") {
		// @ts-ignore
		browser = await arg1.launch(opts);
	} else {
		browser = await puppeteerLaunch(opts);
	}

	if (opts.allowIncognito) {
		const settings = await browser.newPage();
		await settings.goto(`chrome://extensions/?id=${extensionId}`);
		await settings.evaluate(() => {
			(document as any)
				.querySelector("extensions-manager")
				.shadowRoot.querySelector("#viewManager > extensions-detail-view.active")
				.shadowRoot.querySelector(
					"div#container.page-container > div.page-content > div#options-section extensions-toggle-row#allow-incognito"
				)
				.shadowRoot.querySelector("label#label input")
				.click();
		});
		await settings.close();
	}

	(await browser.newPage()).goto(`chrome-extension://${extensionId}/options.html#${port}`);

	const old_browser_close = browser.close;
	browser.close = async () => {
		for (const page of await browser.pages()) {
			if (!page.url().startsWith(`chrome-extension://${extensionId}/options.html`)) {
				await page.close();
			}
		}
		const extension = await getExtensionPage(browser);
		await extension.evaluate(async () => {
			return chrome.tabs.query({});
		});
		if (opts.closeDelay) {
			await new Promise((r) => setTimeout(r, opts.closeDelay));
		}
		await old_browser_close.call(browser);
	};

	return browser;
}

export interface getStreamOptions {
	audio: boolean;
	video: boolean;
	videoConstraints?: any;
	audioConstraints?: any;
	webSocketUrl: string;
	sessionId: string;
	peerConnectionConfig?: any;
}

export async function getExtensionPage(browser: Browser) {
	const extensionTarget = await browser.waitForTarget((target) => {
		return target.type() === "page" && target.url().startsWith(`chrome-extension://${extensionId}/options.html`);
	});
	if (!extensionTarget) throw new Error("cannot load extension");

	const videoCaptureExtension = await extensionTarget.page();
	if (!videoCaptureExtension) throw new Error("cannot get page of extension");

	return videoCaptureExtension;
}

let mutex = false;
let queue: Function[] = [];
const retryPolicy = { each: 20, times: 3 };

function lock() {
	return new Promise((res) => {
		if (!mutex) {
			mutex = true;
			return res(null);
		}
		queue.push(res);
	});
}

function unlock() {
	if (queue.length) queue.shift()();
	else mutex = false;
}

export async function stopStream(page: Page, sessionId: string) {
	const extension = await getExtensionPage(page.browser());
	await lock();
	await page.bringToFront();
	await assertExtensionLoaded(extension, retryPolicy);
	// @ts-ignore
	await extension.evaluate((sessionId) => STOP_RECORDING(sessionId), sessionId);
	unlock();
}

export async function getStream(page: Page, opts: getStreamOptions) {
	if (!opts.audio && !opts.video) throw new Error("At least audio or video must be true");

	const extension = await getExtensionPage(page.browser());

	await lock();
	await page.bringToFront();
	const [tab] = await extension.evaluate(
		async (x) => {
			return chrome.tabs.query(x);
		},
		{
			active: true,
		}
	);
	unlock();
	if (!tab) throw new Error("Cannot find tab, try providing your own tabQuery to getStream options");

	page.on("close", () => {
		if (!extension.isClosed() && extension.browser().connected) {
			// @ts-ignore
			extension.evaluate((index) => STOP_RECORDING(index), index);
		}
	});

	await lock();
	await page.bringToFront();
	await assertExtensionLoaded(extension, retryPolicy);
	await extension.evaluate(
		// @ts-ignore
		(settings) => START_RECORDING(settings),
		opts
	);
	unlock();

	return 'ok';
}

async function assertExtensionLoaded(ext: Page, opt: { each: number; times: number }) {
	const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
	for (let currentTick = 0; currentTick < opt.times; currentTick++) {
		// @ts-ignore
		if (await ext.evaluate(() => typeof START_RECORDING === "function")) return;
		await wait(Math.pow(opt.each, currentTick));
	}
	throw new Error("Could not find START_RECORDING function in the browser context");
}
