/**
 * `dsh-plugin-google-cloud/client`: Web Client UI for the Google Vertex AI plugin in DSH.
 *
 * Registers two official slots:
 * 1. `settings.plugin.item` (key: `google-cloud`) -> the plugin's own configuration card in
 *    "Settings -> Plugins", dispatched by the namespace the Host actually serves
 * 2. `settings.models.provider-card` (key: `google-cloud`) -> Renders in "Settings -> Models"
 *    inside the Vertex AI card
 *
 * Configuration reads and writes go through this namespace's bound settings scope
 * (`ctx.settingsScope.bind({ namespace })`), so an edit from any surface reaches every
 * other one and no surface owns a private copy.
 *
 * @module dsh-plugin-google-cloud/client
 */

window.__ModuleLoader__.load({
	id: "dsh-plugin-google-cloud",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { useState, useEffect, useCallback, useMemo, useRef } = React;
		const { jsx: _jsx, jsxs: _jsxs, Fragment: _Fragment } = require("react/jsx-runtime");

		const NS = "google-cloud";
		const ROUTE = "vertexai";
		const DEFAULT_API_KEY_ENV = "GOOGLE_CLOUD_API_KEY";
		const DEFAULT_SA_ENV = "GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON";

		const AUTH_MODES = [
			{
				id: "express",
				name: "快速模式 (API Key)",
				icon: "🔑",
				desc: "通过 Google Cloud API 密钥快速接入，直接发起 Vertex AI 模型调用",
			},
			{
				id: "full",
				name: "完整模式 (Service Account)",
				icon: "🛡️",
				desc: "使用 GCP 服务账号 JSON 凭据，基于 IAM 权限自动换取与轮换 OAuth2 访问令牌",
			},
		];

		const REGION_PRESETS = [
			// 全局与多区域端点（置顶）
			{ id: "global", label: "global (默认 · 全局端点，无需项目 ID，支持 flex 档位)" },
			{ id: "us", label: "us (美国多区域端点，支持 priority 档位)" },
			{ id: "eu", label: "eu (欧洲多区域端点，支持 priority 档位)" },

			// 美洲区域端点
			{ id: "us-central1", label: "us-central1 (美国爱荷华)" },
			{ id: "us-east4", label: "us-east4 (美国北弗吉尼亚)" },
			{ id: "us-west1", label: "us-west1 (美国俄勒冈)" },
			{ id: "us-west4", label: "us-west4 (美国拉斯维加斯)" },
			{ id: "us-east1", label: "us-east1 (美国南卡罗来纳)" },
			{ id: "us-east5", label: "us-east5 (美国哥伦布)" },
			{ id: "us-south1", label: "us-south1 (美国达拉斯)" },
			{ id: "northamerica-northeast1", label: "northamerica-northeast1 (加拿大蒙特利尔)" },
			{ id: "southamerica-east1", label: "southamerica-east1 (巴西圣保罗)" },

			// 欧洲区域端点
			{ id: "europe-west1", label: "europe-west1 (欧洲比利时)" },
			{ id: "europe-west4", label: "europe-west4 (欧洲荷兰)" },
			{ id: "europe-west9", label: "europe-west9 (欧洲巴黎)" },
			{ id: "europe-west2", label: "europe-west2 (欧洲伦敦)" },
			{ id: "europe-west3", label: "europe-west3 (欧洲法兰克福)" },
			{ id: "europe-north1", label: "europe-north1 (欧洲芬兰)" },
			{ id: "europe-central2", label: "europe-central2 (欧洲华沙)" },
			{ id: "europe-west8", label: "europe-west8 (欧洲米兰)" },
			{ id: "europe-southwest1", label: "europe-southwest1 (欧洲马德里)" },

			// 亚太及大洋洲区域端点
			{ id: "asia-northeast1", label: "asia-northeast1 (亚太东京)" },
			{ id: "asia-southeast1", label: "asia-southeast1 (亚太新加坡)" },
			{ id: "asia-east1", label: "asia-east1 (亚太台湾)" },
			{ id: "asia-south1", label: "asia-south1 (亚太孟买)" },
			{ id: "asia-northeast3", label: "asia-northeast3 (亚太首尔)" },
			{ id: "australia-southeast1", label: "australia-southeast1 (澳洲悉尼)" },

			// 自定义
			{ id: "custom", label: "自定义区域…" },
		];

		const TIERS = [
			{ id: "standard", name: "Standard (标准档)", desc: "官方基准 PayGo 计价与常规延迟，支持所有区域与端点" },
			{ id: "priority", name: "Priority (优先保障档)", desc: "优先队列分配，延迟波动更低、吞吐更稳，单价高于标准档，仅限 global 与 us/eu 端点" },
			{ id: "flex", name: "Flex (低价折扣档)", desc: "享受约五折优惠计费，尽力而为服务 (排队与延迟较高)，仅限 global 端点" },
		];

		// Image generation (`generate_image`): the models stay out of the chat
		// model list — the harness cannot carry assistant image output, so an
		// image model in the picker would answer every prompt with nothing.
		const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";
		const IMAGE_MODEL_OPTIONS = [
			{ id: "gemini-2.5-flash-image", label: "gemini-2.5-flash-image（通用快速 · PNG）" },
			{ id: "gemini-3.1-flash-image", label: "gemini-3.1-flash-image（新一代快速 · PNG）" },
			{ id: "gemini-3-pro-image", label: "gemini-3-pro-image（质量优先 · PNG）" },
			{ id: "gemini-3.1-flash-lite-image", label: "gemini-3.1-flash-lite-image（最省成本 · JPEG）" },
			{ id: "imagen-4.0-generate-001", label: "imagen-4.0-generate-001（Imagen 4 · PNG）" },
			{ id: "imagen-4.0-fast-generate-001", label: "imagen-4.0-fast-generate-001（Imagen 4 Fast · PNG）" },
			{ id: "imagen-4.0-ultra-generate-001", label: "imagen-4.0-ultra-generate-001（Imagen 4 Ultra · PNG）" },
		];
		const IMAGE_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
		const MAX_IMAGE_COUNT = 4;

		const DEFAULT_REGION_MODELS = Object.freeze({
			global: [
				"gemini-3.8-flash",
				"gemini-3.7-flash",
				"gemini-3.6-flash",
				"gemini-3.5-flash",
				"gemini-3.5-flash-lite",
				"gemini-3.1-pro-preview",
				"gemini-3.1-flash-lite",
				"gemini-3-flash-preview",
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-2.0-flash",
				"gemini-2.0-flash-lite",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
				"gemini-1.5-flash-8b",
				"gemini-flash-latest",
				"gemini-flash-lite-latest",
			],
			us: [
				"gemini-3.8-flash",
				"gemini-3.7-flash",
				"gemini-3.6-flash",
				"gemini-3.5-flash",
				"gemini-3.5-flash-lite",
				"gemini-3.1-flash-lite",
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			eu: [
				"gemini-3.8-flash",
				"gemini-3.7-flash",
				"gemini-3.6-flash",
				"gemini-3.5-flash",
				"gemini-3.5-flash-lite",
				"gemini-3.1-flash-lite",
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"us-central1": [
				"gemini-3.8-flash",
				"gemini-3.7-flash",
				"gemini-3.6-flash",
				"gemini-3.5-flash",
				"gemini-3.5-flash-lite",
				"gemini-3.1-pro-preview",
				"gemini-3.1-flash-lite",
				"gemini-3-flash-preview",
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-2.0-flash",
				"gemini-2.0-flash-lite",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
				"gemini-1.5-flash-8b",
			],
			"us-east4": [
				"gemini-3.8-flash",
				"gemini-3.7-flash",
				"gemini-3.6-flash",
				"gemini-3.5-flash",
				"gemini-3.5-flash-lite",
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-2.0-flash",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"us-west1": [
				"gemini-3.8-flash",
				"gemini-3.7-flash",
				"gemini-3.6-flash",
				"gemini-3.5-flash",
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"us-west4": [
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"us-east1": [
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"us-east5": [
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"us-south1": [
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"northamerica-northeast1": [
				"gemini-3.5-flash",
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"southamerica-east1": [
				"gemini-2.5-flash",
				"gemini-1.5-flash",
			],
			"europe-west1": [
				"gemini-3.8-flash",
				"gemini-3.7-flash",
				"gemini-3.6-flash",
				"gemini-3.5-flash",
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"europe-west4": [
				"gemini-3.8-flash",
				"gemini-3.7-flash",
				"gemini-3.6-flash",
				"gemini-3.5-flash",
				"gemini-3.5-flash-lite",
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-2.0-flash",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"europe-west9": [
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"europe-west2": [
				"gemini-3.5-flash",
				"gemini-2.5-flash",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"europe-west3": [
				"gemini-3.5-flash",
				"gemini-2.5-flash",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"europe-north1": [
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"europe-central2": [
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"europe-west8": [
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"europe-southwest1": [
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"asia-northeast1": [
				"gemini-3.8-flash",
				"gemini-3.7-flash",
				"gemini-3.6-flash",
				"gemini-3.5-flash",
				"gemini-3.5-flash-lite",
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-2.5-flash-lite",
				"gemini-2.0-flash",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"asia-southeast1": [
				"gemini-3.8-flash",
				"gemini-3.7-flash",
				"gemini-3.6-flash",
				"gemini-3.5-flash",
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"asia-east1": [
				"gemini-3.8-flash",
				"gemini-3.7-flash",
				"gemini-3.6-flash",
				"gemini-3.5-flash",
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"asia-south1": [
				"gemini-3.5-flash",
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
			"asia-northeast3": [
				"gemini-2.5-flash",
				"gemini-1.5-flash",
			],
			"australia-southeast1": [
				"gemini-3.5-flash",
				"gemini-2.5-pro",
				"gemini-2.5-flash",
				"gemini-1.5-pro",
				"gemini-1.5-flash",
			],
		});
		// Ensure CSS styles are injected once
		const STYLE_ID = "dsh-plugin-google-cloud/styles.css";
		if (typeof document !== "undefined" && !document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) {
			const style = document.createElement("style");
			style.dataset.plugin = "dsh-plugin-google-cloud";
			style.dataset.pluginCss = STYLE_ID;
			style.textContent = `
.dsh-gc-summary {
  color: inherit;
  opacity: 0.85;
}
.dsh-gc-note {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.5;
  opacity: 0.75;
}
.dsh-gc-card {
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(255, 255, 255, 0.12));
  background: var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.04));
  border-radius: 16px;
  list-style: none;
  transition: border-color 0.16s ease, background 0.16s ease;
  margin-bottom: 12px;
}
.dsh-gc-card:hover {
  border-color: var(--dsw-alias-label-dimmed, rgba(255, 255, 255, 0.25));
}
.dsh-gc-card.open {
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.02));
  border-color: var(--dsw-alias-label-dimmed, rgba(255, 255, 255, 0.25));
}
.dsh-gc-header {
  appearance: none;
  width: 100%;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 12px;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  display: flex;
}
.dsh-gc-header:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4f46e5);
  outline-offset: -2px;
}
.dsh-gc-head-text {
  flex-direction: column;
  flex: 1;
  gap: 4px;
  min-width: 0;
  display: flex;
}
.dsh-gc-title {
  color: var(--dsw-alias-label-primary, #fff);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh-gc-desc {
  color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.5));
  font-size: 13px;
  line-height: 1.5;
}
.dsh-gc-badges {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dsh-gc-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-4, rgba(255, 255, 255, 0.08));
  color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.8));
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
  font-weight: 500;
  white-space: nowrap;
}
.dsh-gc-badge.unsaved {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  border-color: rgba(245, 158, 11, 0.3);
}
.dsh-gc-badge.configured {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
  border-color: rgba(16, 185, 129, 0.3);
}
.dsh-gc-badge.missing {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.3);
}
.dsh-gc-chevron {
  color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.5));
  flex: none;
  transition: transform 0.2s ease;
}
.dsh-gc-chevron.open {
  transform: rotate(180deg);
}
.dsh-gc-body {
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
  margin: 0 16px;
  padding: 16px 0 8px;
}
.dsh-gc-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}
.dsh-gc-field + .dsh-gc-field {
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
}
.dsh-gc-field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dsh-gc-field-label {
  color: var(--dsw-alias-label-primary, #fff);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}
.dsh-gc-field-hint {
  color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.5));
  font-size: 12px;
  line-height: 1.5;
  margin: 0;
}
.dsh-gc-field-hint.warn {
  color: #f59e0b;
}
.dsh-gc-field-hint.error {
  color: var(--dsw-alias-label-error, #ef4444);
}
.dsh-gc-input-box {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}
.dsh-gc-input {
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(255, 255, 255, 0.12));
  background: var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.04));
  height: 34px;
  width: 100%;
  font: inherit;
  color: var(--dsw-alias-label-primary, #fff);
  border-radius: 8px;
  padding: 0 12px;
  font-size: 13px;
  line-height: 1.5;
  transition: border-color 0.16s;
  box-sizing: border-box;
}
.dsh-gc-input:focus {
  border-color: var(--dsw-alias-brand-primary, #4f46e5);
  outline: none;
}
.dsh-gc-input:disabled {
  color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.5));
  cursor: not-allowed;
}
.dsh-gc-select {
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(255, 255, 255, 0.12));
  background: var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.04));
  height: 34px;
  width: 100%;
  font: inherit;
  color: var(--dsw-alias-label-primary, #fff);
  border-radius: 8px;
  padding: 0 12px;
  font-size: 13px;
  line-height: 1.5;
  box-sizing: border-box;
  cursor: pointer;
}
.dsh-gc-select option {
  background: #1e1e24;
  color: #fff;
}
.dsh-gc-select:focus {
  border-color: var(--dsw-alias-brand-primary, #4f46e5);
  outline: none;
}
.dsh-gc-tier-group {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
@media (max-width: 600px) {
  .dsh-gc-tier-group {
    grid-template-columns: 1fr;
  }
}
.dsh-gc-tier-card {
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(255, 255, 255, 0.12));
  background: var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.04));
  border-radius: 8px;
  padding: 8px 10px;
  cursor: pointer;
  transition: border-color 0.16s, background 0.16s;
  user-select: none;
  text-align: left;
}
.dsh-gc-tier-card:hover {
  border-color: var(--dsw-alias-label-dimmed, rgba(255, 255, 255, 0.25));
}
.dsh-gc-tier-card.selected {
  border-color: var(--dsw-alias-brand-primary, #4f46e5);
  background: rgba(79, 70, 229, 0.12);
}
.dsh-gc-tier-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #fff);
  margin-bottom: 2px;
}
.dsh-gc-tier-desc {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.5));
  line-height: 1.35;
}
.dsh-gc-mode-group {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
@media (max-width: 600px) {
  .dsh-gc-mode-group {
    grid-template-columns: 1fr;
  }
}
.dsh-gc-mode-card {
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(255, 255, 255, 0.12));
  background: var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.04));
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
  transition: border-color 0.16s, background 0.16s;
  user-select: none;
  text-align: left;
}
.dsh-gc-mode-card:hover {
  border-color: var(--dsw-alias-label-dimmed, rgba(255, 255, 255, 0.25));
}
.dsh-gc-mode-card.selected {
  border-color: var(--dsw-alias-brand-primary, #4f46e5);
  background: rgba(79, 70, 229, 0.12);
}
.dsh-gc-mode-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #fff);
  margin-bottom: 2px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.dsh-gc-mode-desc {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.5));
  line-height: 1.35;
}
.dsh-gc-textarea {
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(255, 255, 255, 0.12));
  background: var(--dsw-alias-bg-layer-3, rgba(255, 255, 255, 0.04));
  width: 100%;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: var(--dsw-alias-label-primary, #fff);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.5;
  box-sizing: border-box;
  resize: vertical;
  min-height: 80px;
  transition: border-color 0.16s;
}
.dsh-gc-textarea:focus {
  border-color: var(--dsw-alias-brand-primary, #4f46e5);
  outline: none;
}
.dsh-gc-textarea:disabled {
  color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.5));
  cursor: not-allowed;
}
.dsh-gc-info-box {
  background: rgba(79, 70, 229, 0.08);
  border: 0.5px solid rgba(79, 70, 229, 0.25);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.8));
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-gc-info-box.success {
  background: rgba(16, 185, 129, 0.08);
  border-color: rgba(16, 185, 129, 0.25);
  color: #10b981;
}
.dsh-gc-footer {
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 14px 0 6px;
  flex-wrap: wrap;
}
.dsh-gc-btn-group {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
.dsh-gc-btn {
  appearance: none;
  font: inherit;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  transition: all 0.16s ease;
  white-space: nowrap;
}
.dsh-gc-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4f46e5);
  outline-offset: 1px;
}
.dsh-gc-btn-primary {
  background: var(--dsw-alias-brand-primary, #4f46e5);
  color: #fff;
}
.dsh-gc-btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}
.dsh-gc-btn-primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.dsh-gc-btn-secondary {
  background: transparent;
  border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12));
  color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.8));
}
.dsh-gc-btn-secondary:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary, #fff);
  border-color: var(--dsw-alias-label-dimmed, rgba(255, 255, 255, 0.25));
}
.dsh-gc-btn-secondary:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.dsh-gc-btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.5));
  padding: 6px 8px;
}
.dsh-gc-btn-ghost:hover:not(:disabled) {
  color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.8));
}
.dsh-gc-status-msg {
  font-size: 12px;
  line-height: 1.5;
  margin: 0;
}
.dsh-gc-status-msg.error {
  color: var(--dsw-alias-label-error, #ef4444);
}
.dsh-gc-status-msg.success {
  color: #10b981;
}

/* Provider card extension in Models page */
.dsh-gc-model-ext {
  margin: 8px 0 4px;
}
.dsh-gc-model-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: var(--dsw-alias-bg-layer-4, rgba(255, 255, 255, 0.03));
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
}
.dsh-gc-model-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex: 1;
  min-width: 0;
}
.dsh-gc-chip {
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.05));
  color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.8));
  font-size: 11px;
  white-space: nowrap;
}
.dsh-gc-toggle-btn {
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-brand-primary, #6366f1);
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 10px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 500;
  transition: background 0.16s ease;
  white-space: nowrap;
  flex-shrink: 0;
}
.dsh-gc-toggle-btn:hover {
  background: rgba(99, 102, 241, 0.1);
}
.dsh-gc-model-drawer {
  margin-top: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.02));
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
  border-radius: 12px;
  padding: 12px 16px;
}

.dsh-gc-sync-box {
  margin-top: 10px;
  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.02));
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dsh-gc-sync-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.dsh-gc-sync-info {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh-gc-sync-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #fff);
}
.dsh-gc-sync-btn {
  font-size: 12px !important;
  padding: 5px 12px !important;
  white-space: nowrap !important;
  flex-shrink: 0 !important;
}
.dsh-gc-sync-models-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 90px;
  overflow-y: auto;
}
.dsh-gc-model-tag {
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.85));
  font-family: var(--dsw-alias-font-code, monospace);
  border: 0.5px solid rgba(255, 255, 255, 0.1);
}
.dsh-gc-model-tag.custom-tag {
  border-color: rgba(99, 102, 241, 0.4);
  color: #a5b4fc;
  background: rgba(99, 102, 241, 0.12);
}

/* Hide DSH's broken unconfigured/unknown provider editor in Settings -> Models */
li:has(.dsh-gc-model-ext) > div:has(p[class*="advancedHint"]),
li:has(.dsh-gc-model-ext) div[data-gc-suppressed="true"] {
  display: none !important;
}
`;
			document.head.appendChild(style);
		}

		/**
		 * Google Cloud Vertex AI Form Component
		 */
		function GoogleCloudConfigForm({ scope, ctx, onSaveSuccess, onClose }) {
			const [snapshot, setSnapshot] = useState(() => scope.getSnapshot());
			const [apiKeyDraft, setApiKeyDraft] = useState("");
			const [showKey, setShowKey] = useState(false);
			const [keyConfigured, setKeyConfigured] = useState(false);
			const [keyWritable, setKeyWritable] = useState(true);

			// Full Mode (Service Account) Draft state
			const [saDraft, setSaDraft] = useState("");
			const [saConfigured, setSaConfigured] = useState(false);
			const [saWritable, setSaWritable] = useState(true);
			const [saParsedInfo, setSaParsedInfo] = useState(null);

			// Draft form state
			const saved = snapshot.value || {};
			const [authMode, setAuthMode] = useState(saved.authMode ?? "express");
			const [displayName, setDisplayName] = useState(saved.displayName ?? "Google Vertex AI");
			const [region, setRegion] = useState(() => {
				const r = saved.region ?? "global";
				return REGION_PRESETS.some((p) => p.id === r) ? r : "custom";
			});
			const [customRegion, setCustomRegion] = useState(() => {
				const r = saved.region ?? "global";
				return REGION_PRESETS.some((p) => p.id === r) ? "" : r;
			});
			const [projectId, setProjectId] = useState(saved.projectId ?? "");
			const [tier, setTier] = useState(saved.tier ?? "standard");
			const [endpoint, setEndpoint] = useState(saved.endpoint ?? "");
			const [timeoutMs, setTimeoutMs] = useState(saved.streamIdleTimeoutMs ?? 300000);
			const [customModelsText, setCustomModelsText] = useState(() => {
				const list = saved.customModels || [];
				return Array.isArray(list) ? list.join("\n") : "";
			});

			// Image generation draft state
			const [imageToolEnabled, setImageToolEnabled] = useState(saved.imageToolEnabled !== false);
			const [imageModel, setImageModel] = useState(saved.imageModel || DEFAULT_IMAGE_MODEL);
			const [imageAspectRatio, setImageAspectRatio] = useState(
				IMAGE_ASPECT_RATIOS.includes(saved.imageAspectRatio) ? saved.imageAspectRatio : "1:1"
			);
			const [imageCount, setImageCount] = useState(() => {
				const value = Number(saved.imageCount);
				return Number.isInteger(value) && value >= 1 && value <= MAX_IMAGE_COUNT ? value : 1;
			});

			const [isSaving, setIsSaving] = useState(false);
			const [statusMsg, setStatusMsg] = useState(null);

			// Subscribe to scope updates
			useEffect(() => {
				return scope.subscribe(() => {
					const next = scope.getSnapshot();
					setSnapshot(next);
				});
			}, [scope]);

			// Check credential status for both API Key and Service Account
			const checkCredentials = useCallback(async (keyRef, saRef) => {
				try {
					if (!ctx.remote?.credentials) return;
					const resp = await ctx.remote.credentials.describe([keyRef, saRef]);
					if (resp?.ok && resp.value) {
						if (resp.value[keyRef]) {
							setKeyConfigured(resp.value[keyRef].configured === true);
							setKeyWritable(resp.value[keyRef].writable !== false);
						}
						if (resp.value[saRef]) {
							setSaConfigured(resp.value[saRef].configured === true);
							setSaWritable(resp.value[saRef].writable !== false);
						}
					}
				} catch (err) {
					console.warn("google-cloud: describe credential error", err);
				}
			}, [ctx]);

			const apiKeyEnv = saved.apiKeyEnv || DEFAULT_API_KEY_ENV;
			const serviceAccountJsonEnv = saved.serviceAccountJsonEnv || DEFAULT_SA_ENV;
			useEffect(() => {
				checkCredentials(apiKeyEnv, serviceAccountJsonEnv);
			}, [apiKeyEnv, serviceAccountJsonEnv, checkCredentials]);

			// Service Account JSON client-side validator
			const validateSaJson = useCallback((text) => {
				const trimmed = (text || "").trim();
				if (!trimmed) {
					setSaParsedInfo(null);
					return null;
				}
				try {
					if (!trimmed.startsWith("{") && (trimmed.endsWith(".json") || trimmed.includes("/") || trimmed.includes("\\"))) {
						const res = { valid: true, isPath: true, path: trimmed };
						setSaParsedInfo(res);
						return res;
					}
					const parsed = JSON.parse(trimmed);
					if (parsed.type !== "service_account") {
						const err = { valid: false, message: '凭据类型错误：type 必须为 "service_account"' };
						setSaParsedInfo(err);
						return err;
					}
					const required = ["project_id", "private_key", "client_email"];
					for (const req of required) {
						if (!parsed[req]) {
							const err = { valid: false, message: `缺少必要字段: ${req}` };
							setSaParsedInfo(err);
							return err;
						}
					}
					const ok = {
						valid: true,
						projectId: parsed.project_id,
						clientEmail: parsed.client_email,
						clientId: parsed.client_id,
					};
					setSaParsedInfo(ok);
					if (!projectId.trim() && parsed.project_id) {
						setProjectId(parsed.project_id);
					}
					return ok;
				} catch (e) {
					const err = { valid: false, message: `JSON 格式错误: ${e.message}` };
					setSaParsedInfo(err);
					return err;
				}
			}, [projectId]);

			const customModelsList = useMemo(() => {
				return customModelsText
					.split(/[\n,]+/)
					.map((s) => s.trim())
					.filter(Boolean);
			}, [customModelsText]);

			// Compute effective region & available models (built-in + custom models)
			const effectiveRegion = (region === "custom" ? customRegion.trim() : region) || "global";
			const regionKey = effectiveRegion.toLowerCase();
			const builtInForRegion = DEFAULT_REGION_MODELS[regionKey] || DEFAULT_REGION_MODELS["global"] || [];
			const availableModelsForRegion = useMemo(() => {
				const set = new Set(builtInForRegion);
				for (const m of customModelsList) {
					set.add(m);
				}
				return Array.from(set);
			}, [builtInForRegion, customModelsList]);

			// Check if form is dirty
			const isDirty = useMemo(() => {
				if (authMode !== (saved.authMode ?? "express")) return true;
				if (apiKeyDraft.trim().length > 0) return true;
				if (saDraft.trim().length > 0) return true;
				if (displayName !== (saved.displayName ?? "Google Vertex AI")) return true;
				if (effectiveRegion !== (saved.region ?? "global")) return true;
				if (projectId !== (saved.projectId ?? "")) return true;
				if (tier !== (saved.tier ?? "standard")) return true;
				if (endpoint !== (saved.endpoint ?? "")) return true;
				if (Number(timeoutMs) !== (saved.streamIdleTimeoutMs ?? 300000)) return true;
				if (JSON.stringify(customModelsList) !== JSON.stringify(saved.customModels || [])) return true;
				if (imageToolEnabled !== (saved.imageToolEnabled !== false)) return true;
				if (imageModel !== (saved.imageModel || DEFAULT_IMAGE_MODEL)) return true;
				if (imageAspectRatio !== (IMAGE_ASPECT_RATIOS.includes(saved.imageAspectRatio) ? saved.imageAspectRatio : "1:1")) return true;
				if (Number(imageCount) !== (Number(saved.imageCount) >= 1 && Number(saved.imageCount) <= MAX_IMAGE_COUNT ? Number(saved.imageCount) : 1)) return true;
				return false;
			}, [authMode, apiKeyDraft, saDraft, displayName, effectiveRegion, projectId, tier, endpoint, timeoutMs, customModelsList, saved, imageToolEnabled, imageModel, imageAspectRatio, imageCount]);

			// Reset to saved snapshot
			const handleDiscard = () => {
				const cur = scope.getSnapshot().value || {};
				setAuthMode(cur.authMode ?? "express");
				setDisplayName(cur.displayName ?? "Google Vertex AI");
				const r = cur.region ?? "global";
				const isPreset = REGION_PRESETS.some((p) => p.id === r);
				setRegion(isPreset ? r : "custom");
				setCustomRegion(isPreset ? "" : r);
				setProjectId(cur.projectId ?? "");
				setTier(cur.tier ?? "standard");
				setEndpoint(cur.endpoint ?? "");
				setTimeoutMs(cur.streamIdleTimeoutMs ?? 300000);
				setCustomModelsText((cur.customModels || []).join("\n"));
				setImageToolEnabled(cur.imageToolEnabled !== false);
				setImageModel(cur.imageModel || DEFAULT_IMAGE_MODEL);
				setImageAspectRatio(IMAGE_ASPECT_RATIOS.includes(cur.imageAspectRatio) ? cur.imageAspectRatio : "1:1");
				setImageCount(Number(cur.imageCount) >= 1 && Number(cur.imageCount) <= MAX_IMAGE_COUNT ? Number(cur.imageCount) : 1);
				setApiKeyDraft("");
				setSaDraft("");
				setSaParsedInfo(null);
				setStatusMsg(null);
			};

			// Reset to plugin defaults
			const handleResetDefaults = () => {
				setAuthMode("express");
				setDisplayName("Google Vertex AI");
				setRegion("global");
				setCustomRegion("");
				setProjectId("");
				setTier("standard");
				setEndpoint("");
				setTimeoutMs(300000);
				setCustomModelsText("");
				setImageToolEnabled(true);
				setImageModel(DEFAULT_IMAGE_MODEL);
				setImageAspectRatio("1:1");
				setImageCount(1);
				setApiKeyDraft("");
				setSaDraft("");
				setSaParsedInfo(null);
				setStatusMsg({ type: "info", text: "已重置为默认值，点击「保存设置」生效。" });
			};

			// Save changes
			const handleSave = async () => {
				setIsSaving(true);
				setStatusMsg(null);
				try {
					// Mode-specific validation
					if (authMode === "express") {
						if (effectiveRegion !== "global" && !projectId.trim() && !endpoint.trim()) {
							setStatusMsg({ type: "error", text: "快速模式下，非 global 区域必须填写 Google Cloud 项目 ID（或显式端点覆盖）。" });
							setIsSaving(false);
							return;
						}
					} else {
						// Full mode: validate draft if provided
						if (saDraft.trim().length > 0) {
							const checked = validateSaJson(saDraft);
							if (!checked?.valid) {
								setStatusMsg({ type: "error", text: "服务账号凭据校验失败: " + checked?.message });
								setIsSaving(false);
								return;
							}
						}
					}

					// Validate tier & region
					if (tier === "flex" && effectiveRegion !== "global" && !endpoint.trim()) {
						setStatusMsg({ type: "error", text: "Flex 档位目前仅在 global 端点可用。" });
						setIsSaving(false);
						return;
					}

					const curSnapshot = scope.getSnapshot();
					const curSaved = curSnapshot.value || {};
					const targetValues = {
						authMode,
						displayName: displayName.trim() || "Google Vertex AI",
						region: effectiveRegion,
						projectId: projectId.trim(),
						tier,
						endpoint: endpoint.trim(),
						streamIdleTimeoutMs: Math.max(1000, Math.min(600000, Number(timeoutMs) || 300000)),
						customModels: customModelsList,
						imageToolEnabled,
						imageModel: imageModel.trim() || DEFAULT_IMAGE_MODEL,
						imageAspectRatio,
						imageCount: Math.max(1, Math.min(MAX_IMAGE_COUNT, Number(imageCount) || 1)),
					};

					const ops = [];
					for (const [key, val] of Object.entries(targetValues)) {
						if (JSON.stringify(val) !== JSON.stringify(curSaved[key])) {
							ops.push({ op: "set", path: [key], value: val });
						}
					}

					if (ops.length > 0) {
						const accepted = await scope.mutate(ops, curSnapshot.revision);
						if (accepted === false) {
							setStatusMsg({ type: "error", text: "配置写入被拒绝（只读配置或版本冲突），请刷新后重试。" });
							setIsSaving(false);
							return;
						}
					}

					// Save API Key if provided
					if (apiKeyDraft.trim().length > 0) {
						const keyRef = curSaved.apiKeyEnv || DEFAULT_API_KEY_ENV;
						if (ctx.remote?.credentials) {
							await ctx.remote.credentials.set(keyRef, apiKeyDraft.trim());
							setApiKeyDraft("");
						}
					}

					// Save Service Account JSON if provided
					if (saDraft.trim().length > 0) {
						const saRef = curSaved.serviceAccountJsonEnv || DEFAULT_SA_ENV;
						if (ctx.remote?.credentials) {
							await ctx.remote.credentials.set(saRef, saDraft.trim());
							setSaDraft("");
						}
					}

					await checkCredentials(curSaved.apiKeyEnv || DEFAULT_API_KEY_ENV, curSaved.serviceAccountJsonEnv || DEFAULT_SA_ENV);

					setStatusMsg({ type: "success", text: "配置已成功保存并即时生效！" });
					if (onSaveSuccess) onSaveSuccess();
					setTimeout(() => setStatusMsg(null), 4000);
				} catch (err) {
					setStatusMsg({ type: "error", text: "保存失败: " + (err?.message || String(err)) });
				} finally {
					setIsSaving(false);
				}
			};

			return _jsxs("div", {
				children: [
					// Field 1: Authentication Mode
					_jsxs("div", {
						className: "dsh-gc-field",
						children: [
							_jsx("span", { className: "dsh-gc-field-label", children: "认证模式 (Authentication Mode)" }),
							_jsx("div", {
								className: "dsh-gc-mode-group",
								children: AUTH_MODES.map((m) =>
									_jsxs(
										"div",
										{
											className: `dsh-gc-mode-card ${authMode === m.id ? "selected" : ""}`,
											onClick: () => setAuthMode(m.id),
											children: [
												_jsxs("div", {
													className: "dsh-gc-mode-title",
													children: [
														_jsx("span", { children: m.icon }),
														m.name,
													],
												}),
												_jsx("div", { className: "dsh-gc-mode-desc", children: m.desc }),
											],
										},
										m.id
									)
								),
							}),
						],
					}),

					// Field 2 (Conditional): Express Mode -> API Key
					authMode === "express"
						? _jsxs("div", {
								className: "dsh-gc-field",
								children: [
									_jsxs("div", {
										className: "dsh-gc-field-head",
										children: [
											_jsx("span", { className: "dsh-gc-field-label", children: "Google Cloud API 密钥 (API Key)" }),
											keyConfigured
												? _jsx("span", { className: "dsh-gc-badge configured", children: "● 已配置" })
												: _jsx("span", { className: "dsh-gc-badge missing", children: "○ 未配置" }),
										],
									}),
									_jsxs("div", {
										className: "dsh-gc-input-box",
										children: [
											_jsx("input", {
												className: "dsh-gc-input",
												type: showKey ? "text" : "password",
												value: apiKeyDraft,
												placeholder: keyConfigured ? "已配置密钥（输入新值可替换，留空保持现状）" : "请输入 Google Cloud Vertex API Key",
												disabled: !keyWritable || isSaving,
												onChange: (e) => setApiKeyDraft(e.target.value),
												autoComplete: "off",
											}),
											_jsx("button", {
												type: "button",
												className: "dsh-gc-btn dsh-gc-btn-ghost",
												style: { position: "absolute", right: 6 },
												onClick: () => setShowKey(!showKey),
												title: showKey ? "隐藏密钥" : "显示密钥",
												children: showKey ? "🙈" : "👁️",
											}),
										],
									}),
									_jsx("p", {
										className: "dsh-gc-field-hint",
										children: `密钥通过 DSH 受管凭据服务（引用 ${apiKeyEnv}）加密存储，不写入 settings.yaml 文件。`,
									}),
								],
						  })
						: null,

					// Field 2 (Conditional): Full Mode -> Service Account JSON
					authMode === "full"
						? _jsxs("div", {
								className: "dsh-gc-field",
								children: [
									_jsxs("div", {
										className: "dsh-gc-field-head",
										children: [
											_jsx("span", { className: "dsh-gc-field-label", children: "服务账号凭据 (Service Account JSON)" }),
											saConfigured
												? _jsx("span", { className: "dsh-gc-badge configured", children: "● 已配置凭据" })
												: _jsx("span", { className: "dsh-gc-badge missing", children: "○ 未配置" }),
										],
									}),
									_jsx("textarea", {
										className: "dsh-gc-textarea",
										rows: 4,
										value: saDraft,
										placeholder: saConfigured
											? "已安全配置服务账号凭据（粘贴新 JSON 或本地路径可更新替换，留空保持现状）"
											: '粘贴 Google Cloud 服务账号 JSON 密钥内容（包含 "type": "service_account", "private_key" ...）或本地 .json 绝对路径',
										disabled: !saWritable || isSaving,
										onChange: (e) => {
											setSaDraft(e.target.value);
											if (e.target.value.trim().length > 10) {
												validateSaJson(e.target.value);
											}
										},
									}),
									saParsedInfo
										? _jsxs("div", {
												className: `dsh-gc-info-box ${saParsedInfo.valid ? "success" : ""}`,
												children: [
													saParsedInfo.valid
														? _jsxs(_Fragment, {
																children: [
																	_jsx("span", { children: `✓ 凭据解析成功！项目: ${saParsedInfo.projectId || "已检测"}, 账号: ${saParsedInfo.clientEmail || "有效"}` }),
																	_jsx("span", { style: { fontSize: 11, opacity: 0.8 }, children: "点击下方「保存设置」后凭据将加密存储并自动生成 OAuth2 访问令牌。" }),
																],
														  })
														: _jsx("span", { style: { color: "#ef4444" }, children: `⚠️ ${saParsedInfo.message}` }),
												],
										  })
										: null,
									_jsx("p", {
										className: "dsh-gc-field-hint",
										children: `服务账号通过 DSH 受管凭据服务（引用 ${serviceAccountJsonEnv}）加密存储，不写入 settings.yaml 文件。`,
									}),
								],
						  })
						: null,

					// Field: Region
					_jsxs("div", {
						className: "dsh-gc-field",
						children: [
							_jsx("span", { className: "dsh-gc-field-label", children: "Vertex AI 区域 (Region)" }),
							_jsx("select", {
								className: "dsh-gc-select",
								value: region,
								disabled: isSaving,
								onChange: (e) => setRegion(e.target.value),
								children: REGION_PRESETS.map((p) =>
									_jsx("option", { value: p.id, children: p.label }, p.id)
								),
							}),
							region === "custom"
								? _jsx("div", {
										style: { marginTop: 6 },
										children: _jsx("input", {
											className: "dsh-gc-input",
											type: "text",
											placeholder: "输入自定义区域，例如 us-south1",
											value: customRegion,
											disabled: isSaving,
											onChange: (e) => setCustomRegion(e.target.value),
										}),
								  })
								: null,
							_jsx("p", {
								className: "dsh-gc-field-hint",
								children: '“global” 直连全局端点；具体区域或多区域端点按区域端点发请求。完整模式下通常推荐 global 或 us-central1。',
							}),
							_jsxs("div", {
								className: "dsh-gc-sync-box",
								children: [
									_jsxs("div", {
										className: "dsh-gc-sync-head",
										children: [
											_jsxs("div", {
												className: "dsh-gc-sync-info",
												children: [
													_jsx("span", { className: "dsh-gc-sync-title", children: `当前区域 (${effectiveRegion}) 可用模型` }),
													_jsx("span", {
														className: "dsh-gc-badge configured",
														children: `${availableModelsForRegion.length} 个模型可用`,
													}),
												],
											}),
										],
									}),
									availableModelsForRegion.length > 0
										? _jsx("div", {
												className: "dsh-gc-sync-models-list",
												children: availableModelsForRegion.map((m) => {
													const isCustom = customModelsList.includes(m);
													return _jsx("span", {
														className: `dsh-gc-model-tag ${isCustom ? "custom-tag" : ""}`,
														children: isCustom ? `${m} (自定义)` : m,
													}, m);
												}),
										  })
										: _jsx("p", {
												style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.5))", margin: 0 },
												children: "当前区域暂无可用模型，您可在下方「自定义模型」中添加任意 Vertex AI 模型 ID。",
										  }),
								],
							}),
						],
					}),

					// Field: Custom Models
					_jsxs("div", {
						className: "dsh-gc-field",
						children: [
							_jsxs("div", {
								className: "dsh-gc-field-head",
								children: [
									_jsx("span", { className: "dsh-gc-field-label", children: "自定义模型 (Custom Models)" }),
									customModelsList.length > 0
										? _jsx("span", { className: "dsh-gc-badge configured", children: `${customModelsList.length} 个自定义模型` })
										: null,
								],
							}),
							_jsx("textarea", {
								className: "dsh-gc-input dsh-gc-textarea",
								rows: 3,
								placeholder: "每行输入一个模型 ID（或以英文逗号分隔），例如：\ngemini-2.5-pro-exp-02-05\nclaude-3-5-sonnet-v2@20241022\nmy-fine-tuned-model",
								value: customModelsText,
								disabled: isSaving,
								onChange: (e) => setCustomModelsText(e.target.value),
							}),
							_jsx("p", {
								className: "dsh-gc-field-hint",
								children: "填入的模型 ID 会追加到当前提供方的模型列表中，供 DSH 模型选择器使用。若 Google 发布了新模型或使用了 Vertex AI 微调模型，可在此直接添加。",
							}),
						],
					}),

					// Field: Image generation tool (generate_image)
					_jsxs("div", {
						className: "dsh-gc-field",
						children: [
							_jsxs("div", {
								className: "dsh-gc-field-head",
								children: [
									_jsx("span", { className: "dsh-gc-field-label", children: "图像生成工具 (generate_image)" }),
									imageToolEnabled
										? _jsx("span", { className: "dsh-gc-badge configured", children: "已启用" })
										: _jsx("span", { className: "dsh-gc-badge missing", children: "已关闭" }),
								],
							}),
							_jsxs("label", {
								style: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" },
								children: [
									_jsx("input", {
										type: "checkbox",
										checked: imageToolEnabled,
										disabled: isSaving,
										onChange: (e) => setImageToolEnabled(e.target.checked),
									}),
									"注册 generate_image 工具（关闭后模型看不到该工具）",
								],
							}),
							_jsxs("div", {
								style: { display: "grid", gap: 8, gridTemplateColumns: "2fr 1fr 1fr", marginTop: 10 },
								children: [
									_jsx("select", {
										className: "dsh-gc-input",
										value: imageModel,
										disabled: isSaving || !imageToolEnabled,
										onChange: (e) => setImageModel(e.target.value),
										children: (IMAGE_MODEL_OPTIONS.some((m) => m.id === imageModel) || !imageModel
											? IMAGE_MODEL_OPTIONS
											: IMAGE_MODEL_OPTIONS.concat([{ id: imageModel, label: `${imageModel}（自定义 id）` }])
										).map((m) => _jsx("option", { value: m.id, children: m.label }, m.id)),
									}),
									_jsx("select", {
										className: "dsh-gc-input",
										value: imageAspectRatio,
										disabled: isSaving || !imageToolEnabled,
										onChange: (e) => setImageAspectRatio(e.target.value),
										children: IMAGE_ASPECT_RATIOS.map((ratio) => _jsx("option", { value: ratio, children: `宽高比 ${ratio}` }, ratio)),
									}),
									_jsx("input", {
										className: "dsh-gc-input",
										type: "number",
										min: 1,
										max: MAX_IMAGE_COUNT,
										step: 1,
										value: imageCount,
										disabled: isSaving || !imageToolEnabled,
										onChange: (e) => setImageCount(e.target.value),
									}),
								],
							}),
							_jsx("p", {
								className: "dsh-gc-field-hint",
								children: `生图模型不会出现在聊天模型下拉框中（对话模型无法承载图片输出），只能通过 generate_image 工具调用；图片会直接显示在对话里。默认模型 ${DEFAULT_IMAGE_MODEL}，默认每次 ${MAX_IMAGE_COUNT} 张以内的 ` + "「按张计费」",
							}),
						],
					}),

					// Field: Project ID
					_jsxs("div", {
						className: "dsh-gc-field",
						children: [
							_jsxs("div", {
								className: "dsh-gc-field-head",
								children: [
									_jsx("span", { className: "dsh-gc-field-label", children: "Google Cloud 项目 ID (Project ID)" }),
									authMode === "express" && effectiveRegion !== "global" && !projectId.trim() && !endpoint.trim()
										? _jsx("span", { className: "dsh-gc-badge missing", children: "此区域必填" })
										: null,
								],
							}),
							_jsx("input", {
								className: "dsh-gc-input",
								type: "text",
								placeholder: authMode === "full" ? "留空时自动使用 Service Account JSON 中的 project_id" : "例如 my-gcp-project-123456（global 端点可留空）",
								value: projectId,
								disabled: isSaving,
								onChange: (e) => setProjectId(e.target.value),
							}),
							_jsx("p", {
								className: `dsh-gc-field-hint ${authMode === "express" && effectiveRegion !== "global" && !projectId.trim() && !endpoint.trim() ? "warn" : ""}`,
								children: authMode === "full"
									? "完整模式下若留空将自动从 Service Account 凭据中提取 project_id。"
									: (effectiveRegion === "global"
										? "快速模式下 region 为 global 时保持留空；非 global 区域时必填。"
										: "⚠️ 快速模式下非 global 区域必须填写项目 ID 才能正确推导请求端点。"),
							}),
						],
					}),

					// Field: Service Tier
					_jsxs("div", {
						className: "dsh-gc-field",
						children: [
							_jsx("span", { className: "dsh-gc-field-label", children: "Pay-as-you-go 服务档位 (Tier)" }),
							_jsx("div", {
								className: "dsh-gc-tier-group",
								children: TIERS.map((t) =>
									_jsxs(
										"div",
										{
											className: `dsh-gc-tier-card ${tier === t.id ? "selected" : ""}`,
											onClick: () => setTier(t.id),
											children: [
												_jsx("div", { className: "dsh-gc-tier-title", children: t.name }),
												_jsx("div", { className: "dsh-gc-tier-desc", children: t.desc }),
											],
										},
										t.id
									)
								),
							}),
							tier === "flex" && effectiveRegion !== "global"
								? _jsx("p", {
										className: "dsh-gc-field-hint error",
										children: "⚠️ 注意：Flex 约五折档位仅限 global 端点可用，请将区域设为 global 或切换档位。",
								  })
								: null,
						],
					}),

					// Field: Display Name
					_jsxs("div", {
						className: "dsh-gc-field",
						children: [
							_jsx("span", { className: "dsh-gc-field-label", children: "模型选择器显示名称" }),
							_jsx("input", {
								className: "dsh-gc-input",
								type: "text",
								placeholder: "Google Vertex AI",
								value: displayName,
								disabled: isSaving,
								onChange: (e) => setDisplayName(e.target.value),
							}),
							_jsx("p", {
								className: "dsh-gc-field-hint",
								children: "在 DSH 模型选择器与提供方列表中展示的名称。",
							}),
						],
					}),

					// Field: Custom Endpoint (Optional)
					_jsxs("div", {
						className: "dsh-gc-field",
						children: [
							_jsx("span", { className: "dsh-gc-field-label", children: "显式端点覆盖 (Endpoint · 选填)" }),
							_jsx("input", {
								className: "dsh-gc-input",
								type: "text",
								placeholder: "留空时按 region 自动推导，如填入自定义反向代理网关",
								value: endpoint,
								disabled: isSaving,
								onChange: (e) => setEndpoint(e.target.value),
							}),
							_jsx("p", {
								className: "dsh-gc-field-hint",
								children: "用于自建代理或内网网关。填写后 region 与 projectId 不参与端点推导。",
							}),
						],
					}),

					// Field: Stream Idle Timeout
					_jsxs("div", {
						className: "dsh-gc-field",
						children: [
							_jsx("span", { className: "dsh-gc-field-label", children: "流式读取最大空闲间隔 (毫秒)" }),
							_jsx("input", {
								className: "dsh-gc-input",
								type: "number",
								step: 1000,
								min: 1000,
								max: 600000,
								value: timeoutMs,
								disabled: isSaving,
								onChange: (e) => setTimeoutMs(e.target.value),
							}),
							_jsx("p", {
								className: "dsh-gc-field-hint",
								children: "一次流式读取允许的最大空闲等待间隔（默认 300000 毫秒 / 5 分钟）。",
							}),
						],
					}),

					// Footer Actions
					_jsxs("div", {
						className: "dsh-gc-footer",
						children: [
							statusMsg
								? _jsx("p", {
										className: `dsh-gc-status-msg ${statusMsg.type}`,
										children: statusMsg.text,
								  })
								: _jsx("span", {}),
							_jsxs("div", {
								className: "dsh-gc-btn-group",
								children: [
									onClose
										? _jsx("button", {
												type: "button",
												className: "dsh-gc-btn dsh-gc-btn-ghost",
												onClick: onClose,
												disabled: isSaving,
												children: "收起",
										  })
										: null,
									_jsx("button", {
										type: "button",
										className: "dsh-gc-btn dsh-gc-btn-ghost",
										onClick: handleResetDefaults,
										disabled: isSaving,
										children: "恢复默认",
									}),
									_jsx("button", {
										type: "button",
										className: "dsh-gc-btn dsh-gc-btn-secondary",
										onClick: handleDiscard,
										disabled: !isDirty || isSaving,
										children: "放弃修改",
									}),
									_jsx("button", {
										type: "button",
										className: "dsh-gc-btn dsh-gc-btn-primary",
										onClick: handleSave,
										disabled: !isDirty || isSaving,
										children: isSaving ? "保存中…" : "保存设置",
									}),
								],
							}),
						],
					}),
				],
			});
		}

		/**
		 * `settings.plugin.item` contribution: this plugin's card in
		 * "Settings -> Plugins", rendered under the namespace key the section
		 * dispatches. Values come from this namespace's bound settings scope, so an
		 * edit here reaches every other surface and vice versa.
		 */
		function GoogleCloudPluginCard(props) {
			const [open, setOpen] = useState(false);
			const { scope, ctx } = props;
			const [snapshot, setSnapshot] = useState(() => scope.getSnapshot());

			useEffect(() => {
				return scope.subscribe(() => {
					setSnapshot(scope.getSnapshot());
				});
			}, [scope]);

			const state = snapshot;
			const saved = state.value || {};
			const modeText = saved.authMode === "full" ? "完整模式 (SA)" : "快速模式 (Key)";
			const regionText = saved.region || "global";
			const tierText = saved.tier || "standard";

			if (state.status === "unavailable") {
				return _jsx("p", {
					className: "dsh-gc-note",
					children: "当前页面无法读写本机配置：配置只在回环地址的 DSH 页面里可编辑。",
				});
			}

			if (state.value === undefined) {
				return _jsx("p", {
					className: "dsh-gc-note",
					children: "正在读取配置…",
				});
			}

			return _jsxs("div", {
				className: `dsh-gc-card ${open ? "open" : ""}`,
				children: [
					_jsxs("button", {
						type: "button",
						className: "dsh-gc-header",
						"aria-expanded": open,
						onClick: () => setOpen(!open),
						children: [
							_jsxs("span", {
								className: "dsh-gc-head-text",
								children: [
									_jsxs("span", {
										className: "dsh-gc-title",
										children: [
											"Google Cloud · Vertex AI",
											_jsx("span", {
												className: "dsh-gc-badge",
												children: `模式: ${modeText}`,
											}),
											_jsx("span", {
												className: "dsh-gc-badge",
												children: `区域: ${regionText}`,
											}),
											_jsx("span", {
												className: "dsh-gc-badge",
												children: `档位: ${tierText}`,
											}),
										],
									}),
									_jsx("span", {
										className: "dsh-gc-desc",
										children: "Google Cloud Vertex AI 模型提供方配置（支持快速模式与完整模式）",
									}),
								],
							}),
							_jsx("svg", {
								className: `dsh-gc-chevron ${open ? "open" : ""}`,
								width: "16",
								height: "16",
								viewBox: "0 0 16 16",
								fill: "none",
								children: _jsx("path", {
									d: "M4 6L8 10L12 6",
									stroke: "currentColor",
									strokeWidth: "1.5",
									strokeLinecap: "round",
									strokeLinejoin: "round",
								}),
							}),
						],
					}),
					open
						? _jsx("div", {
								className: "dsh-gc-body",
								children: _jsx(GoogleCloudConfigForm, {
									scope,
									ctx,
									onSaveSuccess: () => {},
								}),
						  })
						: null,
				],
			});
		}

		/**
		 * Slot Component 2: `settings.models.provider-card` extension for "Settings -> Models"
		 */
		function GoogleCloudModelCardExtra(props) {
			const { scope, ctx, configured } = props;
			const ref = useRef(null);
			const [isDshOpen, setIsDshOpen] = useState(false);
			const [manualExpanded, setManualExpanded] = useState(() => !configured);
			const [snapshot, setSnapshot] = useState(() => scope.getSnapshot());

			const isExpanded = isDshOpen || manualExpanded;

			useEffect(() => {
				return scope.subscribe(() => {
					setSnapshot(scope.getSnapshot());
				});
			}, [scope]);

			useEffect(() => {
				const root = ref.current?.closest("li");
				if (!root) return;

				const checkAndSyncState = () => {
					let dshEditorFound = false;
					const allP = root.querySelectorAll("p");
					for (const p of allP) {
						if (p.textContent && p.textContent.includes("settings.yaml") && p.textContent.includes("google-cloud")) {
							dshEditorFound = true;
							const editorBox = p.closest('div[class*="editor"], div[class*="addBlock"]') || p.parentElement;
							if (editorBox && !editorBox.classList.contains("dsh-gc-model-ext") && !editorBox.contains(ref.current)) {
								editorBox.setAttribute("data-gc-suppressed", "true");
								editorBox.style.setProperty("display", "none", "important");
							}
						}
					}
					setIsDshOpen(dshEditorFound);
				};

				checkAndSyncState();
				const observer = new MutationObserver(checkAndSyncState);
				observer.observe(root, { childList: true, subtree: true });

				// Intercept clicks on the row's buttons during capture phase
				const onCaptureClick = (e) => {
					const btn = e.target.closest("button");
					if (!btn || ref.current?.contains(btn)) return;
					const rowHead = btn.closest('[class*="rowHead"]') || btn.closest('[class*="rowActions"]');
					if (rowHead) {
						const text = (btn.textContent || "").trim();
						const aria = btn.getAttribute("aria-label") || "";
						// If this is an edit button (not remove)
						if (!text.includes("移除") && !text.includes("Remove") && !aria.includes("remove")) {
							setManualExpanded(true);
							setTimeout(checkAndSyncState, 50);
							setTimeout(checkAndSyncState, 200);
						}
					}
				};
				root.addEventListener("click", onCaptureClick, true);

				return () => {
					observer.disconnect();
					root.removeEventListener("click", onCaptureClick, true);
				};
			}, []);

			const closeForm = () => {
				setManualExpanded(false);
				setIsDshOpen(false);
				const root = ref.current?.closest("li");
				if (root) {
					// Try clicking cancel button inside hidden DSH editor
					const cancelBtn = Array.from(root.querySelectorAll("button")).find(
						(b) => !ref.current?.contains(b) && (b.textContent?.includes("取消") || b.textContent?.includes("Cancel"))
					);
					if (cancelBtn) {
						cancelBtn.click();
					}
				}
			};

			const saved = snapshot.value || {};
			const modeText = saved.authMode === "full" ? "🛡️ 完整模式" : "🔑 快速模式";
			const regionText = saved.region || "global";
			const tierText = saved.tier || "standard";
			const projectText = saved.projectId ? `项目: ${saved.projectId}` : null;

			return _jsxs("div", {
				ref,
				className: "dsh-gc-model-ext",
				children: [
					_jsxs("div", {
						className: "dsh-gc-model-bar",
						children: [
							_jsxs("div", {
								className: "dsh-gc-model-chips",
								children: [
									_jsx("span", { className: "dsh-gc-chip", children: modeText }),
									_jsx("span", { className: "dsh-gc-chip", children: `🌐 ${regionText}` }),
									_jsx("span", { className: "dsh-gc-chip", children: `⚡ ${tierText}` }),
									projectText ? _jsx("span", { className: "dsh-gc-chip", children: `📁 ${projectText}` }) : null,
									saved.customModels?.length ? _jsx("span", { className: "dsh-gc-chip", children: `✨ ${saved.customModels.length} 个自定义模型` }) : null,
								],
							}),
							_jsxs("button", {
								type: "button",
								className: "dsh-gc-toggle-btn",
								onClick: () => {
									if (isExpanded) {
										closeForm();
									} else {
										setManualExpanded(true);
									}
								},
								children: [
									"⚙️ ",
									isExpanded ? "收起配置" : "参数配置",
								],
							}),
						],
					}),
					isExpanded
						? _jsx("div", {
								className: "dsh-gc-model-drawer",
								children: _jsx(GoogleCloudConfigForm, {
									scope,
									ctx,
									onClose: closeForm,
									onSaveSuccess: closeForm,
								}),
						  })
						: null,
				],
			});
		}

		/**
		 * Web Client Plugin Entry
		 * @param {import('@deepseek-ai/cordis').Context} ctx
		 */
		function apply(ctx) {
			// This namespace's bound settings scope: live snapshot, subscription, and
			// atomic writes into the shared settings document. Binding adds no read of
			// its own — every scope derives from the section's one describe mirror.
			const scope = ctx.settingsScope.bind({ namespace: NS });

			// "Settings -> Plugins": the card appears only while the Host serves this
			// namespace, because the section dispatches the registered keys through
			// the served-namespace set instead of trusting the slot ledger alone.
			ctx.slots.inject("settings.plugin.item", function* () {
				yield ctx.slots.register(
					{
						name: "settings.plugin.item",
						key: NS,
						inject: () => ({ scope, ctx }),
					},
					GoogleCloudPluginCard
				);
			});

			// "Settings -> Models": the extension rendered inside this plugin's
			// provider row, keyed by the namespace that row configures.
			ctx.slots.inject("settings.models.provider-card", function* () {
				yield ctx.slots.register(
					{
						name: "settings.models.provider-card",
						key: NS,
						inject: () => ({ scope, ctx }),
					},
					GoogleCloudModelCardExtra
				);
			});
		}

		/**
		 * Required Cordis services for client context injection.
		 */
		const inject = [
			"slots",
			"remote",
			"remote.credentials",
			"settingsScope",
		];

		apply.inject = inject;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
