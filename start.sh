#!/bin/bash
mkdir -p "$HOME/workspace/.9router"
ln -sfn "$HOME/workspace/.9router" "$HOME/.9router"
npm i -g 9router@latest --registry=https://registry.npmjs.org --silent 2>&1 | tail -n 3 || true
unset DISPLAY
exec 9router -n -l