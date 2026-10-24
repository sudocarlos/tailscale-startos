ARCHES := x86 arm
# overrides to s9pk.mk must precede the include statement
include node_modules/@start9labs/start-sdk/s9pk.mk

.PHONY: check-version
check-version:
	@bash scripts/check-version.sh

arches: check-version

# Ensure JavaScript is compiled before packing regardless of INGREDIENTS evaluation
$(PACKAGE_ID)_%.s9pk: javascript/index.js
