/**
 * `dsh-plugin-google-cloud`: bring a Google Cloud Vertex AI model provider into DSH.
 *
 * The plugin registers a direct Vertex AI adapter on the `vertexai` provider
 * route and owns the settings of the profile entry that mounts it. The wire
 * format is Vertex AI express mode: the global
 * `aiplatform.googleapis.com/v1` endpoint with `?key=` authentication, or a
 * regional endpoint that carries the project id in the URL path, plus the
 * Service Account (JWT bearer) variant that sends `Authorization: Bearer`.
 *
 * Configuration follows the current harness contract: every field of the
 * plugin's `Config` is `volatile`, so the profile's own patch entry is the one
 * authority. `settings.configure({ auto: false })` marks the entry as one that
 * ships its own page, and the plugin reads the live values through the config
 * reference the loader keeps updating in place — a settings edit reaches the
 * next request without a remount.
 *
 * @module dsh-plugin-google-cloud
 */
import { LlmError, assertUsableApiKey, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import z from '@deepseek-ai/schemastery';
import { VertexExpressAdapter } from './adapter.js';
import { getServiceAccountAccessToken, parseServiceAccount } from './auth.js';
import { listModelsForRegion } from './catalog.js';

/** Plugin name: also the credentials scope. */
export const name = 'google-cloud';

/** Required services. `llm` is the registration target. */
export const inject = ['llm'];

/** The provider route key this plugin registers. */
export const ROUTE = 'vertexai';

/** Fallback settings namespace, used when the mounting entry exposes no id. */
export const NS = 'google-cloud';

/**
 * Plugin configuration. The whole object is `volatile`: the mounting profile
 * entry's `config` block is the single stored authority, every field stays
 * editable live through the configuration surfaces, and no edit remounts the
 * plugin.
 */
export const Config = z.object({
	displayName: z
		.string()
		.default('Google Vertex AI')
		.description('模型选择器与设置页显示的提供方名称。'),
	authMode: z
		.union(['express', 'full'])
		.default('express')
		.description('认证模式：express（快速模式，使用 API Key）或 full（完整模式，使用 Service Account JSON 凭据）。'),
	apiKeyEnv: z
		.string()
		.pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)
		.default('GOOGLE_CLOUD_API_KEY')
		.description('API Key 凭据引用（环境变量名）。密钥本身通过 Models 页、凭据服务、~/.dsh/.env 或启动环境提供，绝不写进配置。'),
	serviceAccountJsonEnv: z
		.string()
		.pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)
		.default('GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON')
		.description('Service Account JSON 凭据引用（环境变量名）。完整模式下生效，凭据通过 Models 页设置或启动环境注入。'),
	region: z
		.string()
		.pattern(/^[A-Za-z0-9-]*$/)
		.default('global')
		.description('Vertex AI 区域。"global"（默认）直连全局端点；填 us-central1 等区域或 us、eu 多区域时发往对应区域端点。'),
	projectId: z
		.string()
		.pattern(/^[A-Za-z0-9-]*$/)
		.default('')
		.description('Google Cloud 项目 ID。完整模式下留空可自动从 Service Account 提取；快速模式下非 global 区域必填。'),
	tier: z
		.union(['standard', 'priority', 'flex'])
		.default('standard')
		.description('Pay-as-you-go 服务档位：standard（标准档，基准计价与常规延迟）、priority（优先保障档，队列优先分配、更低延迟波动与吞吐保障，单价更高，仅限 global 与 us/eu 端点）、flex（低价折扣档，约五折优惠计费、排队与延迟较高，仅限 global 端点）。'),
	endpoint: z
		.string()
		.default('')
		.description('显式端点覆盖（如反向代理），填写后 region 与 projectId 不参与推导；留空时按 region 自动推导。'),
	streamIdleTimeoutMs: z
		.number()
		.step(1)
		.min(1000)
		.max(600000)
		.default(300000)
		.description('一次流式读取允许的最大空闲间隔。'),
	customModels: z
		.array(z.string())
		.default([])
		.description('自定义模型列表。填入的模型 ID 会追加到当前可用模型列表供选择器使用。'),
}).description('Google Cloud · Vertex AI（支持 API Key 快速模式与 Service Account 完整模式）').volatile();

/**
 * The plugin entry: register the adapter, the configurable-provider directory
 * entry, model discovery, and the settings presentation policy.
 * @param {object} ctx - the Cordis plugin context.
 * @param {{get: () => object} | object | undefined} config - the resolved
 *   volatile configuration reference of the mounting entry.
 */
export function apply(ctx, config) {
	/**
	 * The current configuration values. The loader keeps the mounting entry's
	 * reference updated in place, so this reads whatever the last accepted
	 * settings write produced.
	 * @returns {object} the live configuration values.
	 */
	function values() {
		if (config === undefined || config === null) return {};
		return typeof config.get === 'function' ? config.get() : config;
	}

	/** The settings namespace this plugin serves: the mounting entry's id. */
	const settingsNs = ctx.fiber?.entry?.options?.id ?? NS;

	/**
	 * Resolve one credential reference to a usable API key.
	 * @param {string} ref - the environment-variable-shaped reference.
	 * @returns {Promise<string>} the trimmed key.
	 */
	async function resolveApiKey(ref) {
		const credentials = ctx.get('credentials');
		const hit = credentials !== undefined
			? (await credentials.resolve(ref))?.value
			: launchEnvironmentOf(ctx).get(ref)?.value;
		if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, name, ref);
		throw new LlmError(
			`google-cloud: no API key for provider route "${ROUTE}"; its profile resolves ${ref}, which is not set — store ${ref} through the credentials service (the web Models page writes it), edit ~/.dsh/.credentials.yaml, add it to ~/.dsh/.env, or export it in the launch environment`,
			'MISSING_CREDENTIAL',
		);
	}

	/**
	 * Resolve one credential reference to a parsed Service Account object.
	 * @param {string} ref - the environment-variable-shaped reference or file path.
	 * @returns {Promise<object>} the parsed service account object.
	 */
	async function resolveServiceAccount(ref) {
		const credentials = ctx.get('credentials');
		let raw = credentials !== undefined
			? (await credentials.resolve(ref))?.value
			: launchEnvironmentOf(ctx).get(ref)?.value;
		if ((raw === undefined || raw.length === 0) && (ref.startsWith('{') || ref.endsWith('.json') || ref.includes('/') || ref.includes('\\'))) {
			raw = ref;
		}
		if (raw !== undefined && raw.trim().length > 0) {
			return parseServiceAccount(raw);
		}
		throw new LlmError(
			`google-cloud: no Service Account credentials for provider route "${ROUTE}"; its profile resolves ${ref}, which is not set — store ${ref} through the credentials service (in DSH Settings or Models), edit ~/.dsh/.credentials.yaml, add it to ~/.dsh/.env, or export it in the launch environment`,
			'MISSING_CREDENTIAL',
		);
	}

	/**
	 * Resolve the durable image-access path of one attachment in the current
	 * execution world, exactly as the shared content helpers do.
	 * @param {object | undefined} attachments - the durable attachment provider, when mounted.
	 * @param {object} ref - the durable normalized attachment reference.
	 * @returns {{readonlyPath: string} | undefined} the access facts, or undefined when unavailable.
	 */
	function resolveImageAccess(attachments, ref) {
		const provider = attachments ?? ctx.get('attachments');
		if (provider === undefined) return undefined;
		try {
			return resolveImageAttachmentAccess(
				provider,
				(hostPath) => ctx.get('fs')?.processPathFromHostPath?.(hostPath),
				ref,
			);
		} catch {
			// An unusable durable reference simply has no model-facing path.
			return undefined;
		}
	}

	const adapter = new VertexExpressAdapter({
		resolveConnection: () => {
			const value = values();
			const authMode = value.authMode ?? 'express';
			return {
				displayName: value.displayName ?? 'Google Vertex AI',
				authMode,
				endpoint: typeof value.endpoint === 'string' ? value.endpoint : '',
				region: value.region ?? 'global',
				projectId: value.projectId ?? '',
				tier: value.tier ?? 'standard',
				streamIdleTimeoutMs: value.streamIdleTimeoutMs ?? 300000,
				resolveApiKey: () => resolveApiKey(value.apiKeyEnv ?? 'GOOGLE_CLOUD_API_KEY'),
				resolveAuth: async () => {
					if (authMode === 'full') {
						const saRef = value.serviceAccountJsonEnv ?? 'GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON';
						const sa = await resolveServiceAccount(saRef);
						const accessToken = await getServiceAccountAccessToken(sa, globalThis.fetch.bind(globalThis));
						return {
							mode: 'full',
							accessToken,
							projectId: sa.project_id,
							clientEmail: sa.client_email,
						};
					}
					const apiKey = await resolveApiKey(value.apiKeyEnv ?? 'GOOGLE_CLOUD_API_KEY');
					return {
						mode: 'express',
						apiKey,
					};
				},
			};
		},
		onTrafficType: (trafficType) => {
			ctx.logger.info('google-cloud: request served with trafficType %s', trafficType);
		},
		listModels: () => {
			const value = values();
			return listModelsForRegion(value.region ?? 'global', value.customModels ?? []);
		},
		resolveAttachments: () => ctx.get('attachments'),
		resolveImageAccess,
		resolveFileText: (ref) => {
			try {
				return ctx.llm.fileRequestText(ref);
			} catch {
				return undefined;
			}
		},
		fetch: globalThis.fetch.bind(globalThis),
	});

	/**
	 * The route facts that decide whether the registration still describes the
	 * adapter: the route set and the display name `providerInfo` reports.
	 * @returns {string} a stable projection of those facts.
	 */
	function registrationFactsOf() {
		return JSON.stringify([ROUTE, values().displayName ?? 'Google Vertex AI']);
	}

	let registration;
	let registrationFacts;
	/**
	 * Keep the adapter registration in step with the live display name. A route
	 * metadata change is a replacement, not a new route: the runtime re-reads
	 * `providerInfo` and announces the topology update.
	 */
	const syncRegistration = () => {
		const facts = registrationFactsOf();
		if (facts === registrationFacts) return;
		if (registration === undefined) registration = ctx.llm.registerAdapter([ROUTE], adapter);
		else registration.replace([ROUTE]);
		registrationFacts = facts;
	};
	syncRegistration();

	/**
	 * The configurable-provider directory entry for this route. An empty
	 * `settingsPath` addresses the entry's own configuration root, which is a
	 * legal declaration (the configurable-provider contract rejects only empty
	 * path *segments*).
	 * @returns {object[]} the single directory entry this adapter owns.
	 */
	function directoryEntries() {
		const value = values();
		return [{
			provider: ROUTE,
			displayName: value.displayName ?? 'Google Vertex AI',
			settingsNs,
			settingsPath: [],
			declared: false,
		}];
	}

	let directory;
	let directoryFacts;
	const syncDirectory = () => {
		const entries = directoryEntries();
		const facts = JSON.stringify(entries);
		if (facts === directoryFacts) return;
		if (directory === undefined) directory = ctx.llm.registerConfigurableProviders(entries);
		else directory.replace(entries);
		directoryFacts = facts;
	};
	syncDirectory();

	ctx.llm.registerModelDiscovery(settingsNs, (_request, signal) => {
		signal?.throwIfAborted?.();
		const value = values();
		return listModelsForRegion(value.region ?? 'global', value.customModels ?? []).map((model) => ({
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			inputModalities: ['text', 'image'],
		}));
	});

	// The plugin ships its own configuration page, so the entry opts out of any
	// schema-generated page. The child context passes this plugin's fiber, so a
	// late or replaced Settings service still adopts the policy.
	ctx.inject(['settings'], (settingsCtx) => {
		settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber));
	});

	// A volatile-only write updates the config reference in place; re-derive the
	// surfaces that mirror configuration. A candidate the runtime rejects is
	// logged and leaves the previous registration in place.
	ctx.on('loader/volatile-update', () => {
		try {
			syncRegistration();
			syncDirectory();
		} catch (error) {
			ctx.logger.error('google-cloud: keeping the previous route and directory entry after a refused update');
			ctx.logger.error(error);
		}
	});

	ctx.logger.info(
		'google-cloud: Vertex AI route "%s" registered (mode: %s, region: %s, ns: %s)',
		ROUTE,
		values().authMode ?? 'express',
		values().region ?? 'global',
		settingsNs,
	);
}
