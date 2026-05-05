import { tryParseJson } from "@oh-my-pi/pi-utils";
import type { RenderResult, SpecialHandler } from "./types";
import { buildResult, formatNumber, loadPage } from "./types";

interface CoinGeckoResponse {
	id: string;
	symbol: string;
	name: string;
	description?: { en?: string };
	links?: {
		homepage?: string[];
		blockchain_site?: string[];
		repos_url?: { github?: string[] };
	};
	market_data?: {
		current_price?: { usd?: number };
		market_cap?: { usd?: number };
		total_volume?: { usd?: number };
		price_change_percentage_24h?: number;
		ath?: { usd?: number };
		ath_date?: { usd?: string };
		circulating_supply?: number;
		total_supply?: number;
		max_supply?: number;
	};
	categories?: string[];
	genesis_date?: string;
}

/**
 * Handle CoinGecko cryptocurrency URLs via API
 */
export const handleCoinGecko: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | null> => {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.includes("coingecko.com")) return null;

		// Extract coin ID from /coins/{id} or /en/coins/{id}
		const match = parsed.pathname.match(/^(?:\/[a-z]{2})?\/coins\/([^/?#]+)/);
		if (!match) return null;

		const coinId = decodeURIComponent(match[1]);
		const fetchedAt = new Date().toISOString();

		// Fetch from CoinGecko API
		const apiUrl = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`;
		const result = await loadPage(apiUrl, {
			timeout,
			headers: { Accept: "application/json" },
			signal,
		});

		if (!result.ok) {
			return buildResult(`# ${coinId}\n\nCoinGecko market data is currently unavailable for this asset.\n`, {
				url,
				method: "coingecko",
				fetchedAt,
				notes: ["CoinGecko API request failed"],
			});
		}

		const coin = tryParseJson<CoinGeckoResponse>(result.content);
		if (!coin) {
			return buildResult(`# ${coinId}\n\nCoinGecko response could not be parsed for this asset.\n`, {
				url,
				method: "coingecko",
				fetchedAt,
				notes: ["CoinGecko API response parsing failed"],
			});
		}

		const md = renderCoinMarkdown(coin);
		return buildResult(md, { url, method: "coingecko", fetchedAt, notes: ["Fetched via CoinGecko API"] });
	} catch {}

	return null;
};

function renderCoinMarkdown(coin: CoinGeckoResponse): string {
	const parts: string[] = [];
	parts.push(`# ${coin.name} (${coin.symbol.toUpperCase()})\n`);

	const market = coin.market_data;
	if (market) {
		renderMarketData(market, parts);
		parts.push("");
		renderSupplyInfo(market, parts);
	}

	if (coin.genesis_date !== null && coin.genesis_date !== undefined && coin.genesis_date !== "") {
		parts.push(`**Launch Date:** ${coin.genesis_date}`);
	}

	if (coin.categories && coin.categories.length > 0) {
		parts.push(`**Categories:** ${coin.categories.join(", ")}`);
	}

	renderLinks(coin.links, parts);
	renderDescription(coin.description?.en, parts);

	return parts.join("\n");
}

function renderMarketData(market: Exclude<CoinGeckoResponse["market_data"], undefined>, parts: string[]): void {
	if (market.current_price?.usd !== undefined) {
		let line = `**Price:** $${formatPrice(market.current_price.usd)}`;
		if (market.price_change_percentage_24h !== undefined) {
			const change = market.price_change_percentage_24h;
			line += ` (${change >= 0 ? "+" : ""}${change.toFixed(2)}% 24h)`;
		}
		parts.push(line);
	}

	if (market.market_cap?.usd) {
		parts.push(`**Market Cap:** $${formatNumber(market.market_cap.usd)}`);
	}

	if (market.total_volume?.usd) {
		parts.push(`**24h Volume:** $${formatNumber(market.total_volume.usd)}`);
	}

	if (market.ath?.usd !== undefined) {
		let line = `**All-Time High:** $${formatPrice(market.ath.usd)}`;
		if (market.ath_date?.usd) {
			const athDate = new Date(market.ath_date.usd).toLocaleDateString("en-US", {
				year: "numeric",
				month: "short",
				day: "numeric",
			});
			line += ` (${athDate})`;
		}
		parts.push(line);
	}
}

function renderSupplyInfo(market: Exclude<CoinGeckoResponse["market_data"], undefined>, parts: string[]): void {
	if (market.circulating_supply) {
		let line = `**Circulating Supply:** ${formatNumber(Math.round(market.circulating_supply))}`;
		if (market.max_supply) {
			const percent = ((market.circulating_supply / market.max_supply) * 100).toFixed(1);
			line += ` / ${formatNumber(Math.round(market.max_supply))} (${percent}%)`;
		} else if (market.total_supply) {
			line += ` / ${formatNumber(Math.round(market.total_supply))} total`;
		}
		parts.push(line);
	}
}

function renderLinks(links: CoinGeckoResponse["links"], parts: string[]): void {
	if (!links) return;
	const items: string[] = [];
	if (links.homepage?.[0]) items.push(`[Website](${links.homepage[0]})`);
	if (links.blockchain_site?.[0]) items.push(`[Explorer](${links.blockchain_site[0]})`);
	if (links.repos_url?.github?.[0]) items.push(`[GitHub](${links.repos_url.github[0]})`);

	if (items.length > 0) {
		parts.push(`**Links:** ${items.join(" · ")}`);
	}
}

function renderDescription(en: string | undefined, parts: string[]): void {
	if (en !== null && en !== undefined && en !== "") {
		const desc = en
			.replace(/<[^>]+>/g, "") // Strip HTML
			.replace(/\r\n/g, "\n")
			.trim();
		if (desc) {
			parts.push(`\n## About\n\n${desc}`);
		}
	}
}

/**
 * Format price with appropriate decimal places
 */
function formatPrice(price: number): string {
	if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
	if (price >= 1) return price.toFixed(2);
	if (price >= 0.01) return price.toFixed(4);
	if (price >= 0.0001) return price.toFixed(6);
	return price.toFixed(8);
}
