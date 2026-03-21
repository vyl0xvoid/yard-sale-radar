#!/bin/zsh
export PATH="/opt/homebrew/bin:$PATH"
cd /Users/voidstatekate/projects/yard-sale-radar || exit 1
/opt/homebrew/bin/node /Users/voidstatekate/projects/yard-sale-radar/scripts/rss-collector.js >> /Users/voidstatekate/projects/yard-sale-radar/data/craigslist-collector.log 2>&1
