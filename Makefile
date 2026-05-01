# Parley — top-level operational targets. The intent is "one command from
# fresh checkout to running stack" per ROADMAP.md Phase 6a.
#
# Local-only. No CI/CD targets here — that's deliberately out of scope for
# Phase 6 (see ROADMAP.md "What Phase 6 deliberately does not do").

SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c

INFRA_STATE := infra/state
USER_PEM := $(INFRA_STATE)/user-agent/axl.pem
MM_PEM   := $(INFRA_STATE)/mm-agent/axl.pem
MM2_PEM  := $(INFRA_STATE)/mm-agent-2/axl.pem

.PHONY: help deploy-local deploy-prod up up-prod down down-prod logs logs-prod build build-prod axl-keys clean check-env

help:
	@echo "Parley — Docker workflow"
	@echo ""
	@echo "Local (developer laptop):"
	@echo "  make axl-keys       Generate ed25519 PEMs for both agents (idempotent)"
	@echo "  make build          docker compose build (no up)"
	@echo "  make deploy-local   axl-keys + build + up -d"
	@echo "  make up             docker compose up -d"
	@echo "  make down           docker compose down"
	@echo "  make logs           docker compose logs -f"
	@echo "  make clean          down + remove built images + volumes"
	@echo ""
	@echo "Production (single VPS behind Traefik — Phase 6b):"
	@echo "  make deploy-prod    axl-keys + build-prod + up-prod"
	@echo "  make build-prod     docker compose -f compose.yml -f compose.prod.yml build"
	@echo "  make up-prod        docker compose -f compose.yml -f compose.prod.yml up -d"
	@echo "  make down-prod      docker compose -f compose.yml -f compose.prod.yml down"
	@echo "  make logs-prod      docker compose -f compose.yml -f compose.prod.yml logs -f"
	@echo ""
	@echo "Prereqs: a populated .env at the repo root (see .env.example)."
	@echo "Production additionally needs MINIAPP_HOST + TRAEFIK_* env vars set."

# `deploy-local` is the headline target — fresh checkout to running stack.
# Order matters: keys must exist before the entrypoints will start.
deploy-local: check-env axl-keys build up
	@echo ""
	@echo "Stack up. Tail logs with: make logs"
	@echo "Mini App: http://localhost:3000"
	@echo "User Agent AXL HTTP API (host-bound): proxied via container 127.0.0.1:9001"

check-env:
	@if [[ ! -f .env ]]; then \
	  echo "ERROR: .env not found at repo root. Copy .env.example to .env and fill it in." >&2; \
	  exit 1; \
	fi

# AXL identity is per-agent, NOT per-image. Mounting from the host means
# rebuilding the image doesn't churn keys (which would break ENS axl_pubkey
# records — see deployment.md §3).
axl-keys: $(USER_PEM) $(MM_PEM) $(MM2_PEM)

$(USER_PEM):
	@mkdir -p "$$(dirname $@)"
	@if [[ ! -f $@ ]]; then \
	  openssl genpkey -algorithm ed25519 -out "$@"; \
	  chmod 600 "$@"; \
	  echo "Generated $@ — back up before redeploying production"; \
	fi

$(MM_PEM):
	@mkdir -p "$$(dirname $@)"
	@if [[ ! -f $@ ]]; then \
	  openssl genpkey -algorithm ed25519 -out "$@"; \
	  chmod 600 "$@"; \
	  echo "Generated $@ — its pubkey must be set on mm-N.parley.eth ENS axl_pubkey record"; \
	fi

# Phase 7: second MM Agent (mm-agent-2). Same shape as $(MM_PEM); the
# entrypoint refuses to start without it. Generated alongside the others
# so `make axl-keys` brings the whole stack up; mm-agent-2 simply won't
# trade until MM2_EVM_PRIVATE_KEY is set in .env and mm-2.parley.eth is
# registered.
$(MM2_PEM):
	@mkdir -p "$$(dirname $@)"
	@if [[ ! -f $@ ]]; then \
	  openssl genpkey -algorithm ed25519 -out "$@"; \
	  chmod 600 "$@"; \
	  echo "Generated $@ — its pubkey must be set on mm-2.parley.eth ENS axl_pubkey record"; \
	fi

build:
	docker compose build

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

# Production overlay: layers compose.prod.yml on top of compose.yml.
# Removes the miniapp's host port binding and wires Traefik labels for
# HTTPS routing through your existing Traefik instance.
PROD_COMPOSE := -f compose.yml -f compose.prod.yml

deploy-prod: check-env axl-keys build-prod up-prod
	@echo ""
	@echo "Stack up. Tail logs with: make logs-prod"
	@echo "Mini App should resolve at https://$${MINIAPP_HOST:-parley-miniapp.b11a.xyz} once Traefik issues the cert."

build-prod:
	docker compose $(PROD_COMPOSE) build

up-prod:
	docker compose $(PROD_COMPOSE) up -d

down-prod:
	docker compose $(PROD_COMPOSE) down

logs-prod:
	docker compose $(PROD_COMPOSE) logs -f

clean:
	docker compose down --volumes --remove-orphans
	-docker rmi parley-user-agent parley-mm-agent parley-miniapp 2>/dev/null
	@echo "Cleaned. Run 'make deploy-local' to start fresh (keys are preserved)."
