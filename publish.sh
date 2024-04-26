#!/bin/bash

set -ex
labelVersion=tag.`date -u +%Y.%m%d.%H%M`

echo "Tagging with $labelVersion"
git tag "$labelVersion" --force
git push && \
    git push --tags --force
