const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

function fetchEndpoint(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                return reject(new Error(`Status ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function cleanStreamUrl(value) {
    return String(value || '').trim().replace(/[,\s]+$/g, '');
}

function toDaiUrl(streamUrl) {
    if (!streamUrl) return '';
    if (streamUrl.includes('dai-fancode.pages.dev')) return cleanStreamUrl(streamUrl);
    const match = streamUrl.match(/(mumbai\/[^\/]+)/);
    if (match) {
        return `https://dai-fancode.pages.dev/${match[1]}/index.m3u8|User-Agent=ReactNativeVideo/9.11.1 (Linux;Android 13) AndroidXMedia3/1.6.1&Referer=https://fancode.com/`;
    }
    return cleanStreamUrl(streamUrl);
}

function parseM3U(content) {
    const lines = content.split('\n');
    const matches = [];
    let cur = null;
    for (let rawLine of lines) {
        const line = rawLine.trim();
        if (line.startsWith('#EXTINF:')) {
            cur = {};
            const idMatch = line.match(/tvg-id="([^"]+)"/i);
            cur.match_id = idMatch ? idMatch[1] : '';
            const nameMatch = line.match(/tvg-name="([^"]+)"/i);
            cur.match_name = nameMatch ? nameMatch[1] : '';
            cur.title = cur.match_name;
            const logoMatch = line.match(/tvg-logo="([^"]+)"/i);
            cur.src = logoMatch ? logoMatch[1] : '';
            const langMatch = line.match(/tvg-language="([^"]+)"/i);
            cur.language = langMatch ? langMatch[1] : 'English';
            const groupMatch = line.match(/group-title="([^"]+)"/i);
            cur.event_category = groupMatch ? groupMatch[1] : 'Cricket';
            const commaSplit = line.split(',');
            if (commaSplit.length > 1 && !cur.title) {
                cur.title = commaSplit[commaSplit.length - 1].trim();
                cur.match_name = cur.title;
            }
        } else if (line.startsWith('http') && cur) {
            cur.stream_url = toDaiUrl(line);
            cur.status = 'LIVE';
            if (cur.match_id) {
                const baseId = String(cur.match_id).split('_')[0].toLowerCase();
                const lang = (cur.language || 'English').trim();
                const langLower = lang.toLowerCase();
                const langCode = langLower.substring(0, 3);
                
                // Keep multi-language streams distinct (e.g. 139506_hin, 139506_tam)
                if (langLower !== 'english' && !String(cur.match_id).toLowerCase().includes('_')) {
                    cur.match_id = `${baseId}_${langCode}`;
                }
                if (!cur.title.toLowerCase().includes(langLower) && !cur.title.toLowerCase().includes(`[${langCode}]`)) {
                    cur.title = `${cur.title} [${lang}]`;
                    cur.match_name = cur.title;
                }
                matches.push(cur);
            }
            cur = null;
        }
    }
    return matches;
}

async function syncFanCode() {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    console.log(`[${timestamp} IST] 🔄 Starting FanCode feed synchronization...`);

    const matchesMap = new Map();

    // 1. Fetch from doctor-8trange's active M3U
    try {
        console.log('Fetching doctor-8trange zyphx8 fancode.m3u...');
        const m3uText = await fetchEndpoint('https://raw.githubusercontent.com/doctor-8trange/zyphx8/main/data/fancode.m3u');
        const m3uMatches = parseM3U(m3uText);
        console.log(`Loaded ${m3uMatches.length} active streams from doctor-8trange.`);
        m3uMatches.forEach(m => {
            const uniqueId = String(m.match_id).toLowerCase();
            matchesMap.set(uniqueId, m);
        });
    } catch (err) {
        console.warn('⚠️ Could not fetch doctor-8trange M3U:', err.message);
    }

    // 2. Fetch from drmlive fancode.json
    try {
        console.log('Fetching drmlive fancode.json...');
        const jsonText = await fetchEndpoint('https://raw.githubusercontent.com/drmlive/fancode-live-events/main/fancode.json');
        const jsonData = JSON.parse(jsonText);
        const jsonMatches = jsonData.matches || jsonData || [];
        console.log(`Loaded ${jsonMatches.length} matches from drmlive.`);

        jsonMatches.forEach(jm => {
            const rawId = String(jm.match_id || '').toLowerCase();
            const baseId = rawId.split('_')[0];
            const targetKey = matchesMap.has(rawId) ? rawId : (matchesMap.has(baseId) ? baseId : rawId);

            const rawStream = jm.adfree_url || jm.dai_url || jm.url || '';
            const streamUrl = toDaiUrl(rawStream);

            if (matchesMap.has(targetKey)) {
                const existing = matchesMap.get(targetKey);
                if (!existing.startTime && jm.startTime) existing.startTime = jm.startTime;
                if (!existing.team_1 && jm.team_1) existing.team_1 = jm.team_1;
                if (!existing.team_2 && jm.team_2) existing.team_2 = jm.team_2;
                if (!existing.event_name && (jm.event_name || jm.tournament)) existing.event_name = jm.event_name || jm.tournament;
                if (!existing.src && jm.src) existing.src = jm.src;
                if (streamUrl && !existing.stream_url) existing.stream_url = streamUrl;
            } else {
                matchesMap.set(targetKey, {
                    match_id: jm.match_id || targetKey,
                    title: jm.title || jm.match_name || 'Live Match',
                    match_name: jm.match_name || jm.title || 'Live Match',
                    src: jm.src || jm.image || '',
                    event_category: jm.event_category || jm.category || 'Cricket',
                    event_name: jm.event_name || jm.tournament || '',
                    language: jm.language || (rawId.includes('_hin') ? 'Hindi' : (rawId.includes('_tam') ? 'Tamil' : 'English')),
                    startTime: jm.startTime || '',
                    status: jm.status || (streamUrl ? 'LIVE' : 'UPCOMING'),
                    stream_url: streamUrl
                });
            }
        });
    } catch (err) {
        console.warn('⚠️ Could not fetch drmlive JSON:', err.message);
    }

    // Enrich multi-language streams with parent / sibling metadata
    matchesMap.forEach((m, key) => {
        const baseId = String(m.match_id).split('_')[0].toLowerCase();
        if (key !== baseId && matchesMap.has(baseId)) {
            const parent = matchesMap.get(baseId);
            if (!m.src && parent.src) m.src = parent.src;
            if (!parent.src && m.src) parent.src = m.src;
            if (!m.startTime && parent.startTime) m.startTime = parent.startTime;
            if (!parent.startTime && m.startTime) parent.startTime = m.startTime;
            if (!m.team_1 && parent.team_1) m.team_1 = parent.team_1;
            if (!parent.team_1 && m.team_1) parent.team_1 = parent.team_1;
            if (!m.team_2 && parent.team_2) m.team_2 = parent.team_2;
            if (!parent.team_2 && m.team_2) parent.team_2 = parent.team_2;
            if (!m.event_name && parent.event_name) m.event_name = parent.event_name;
            if (!parent.event_name && m.event_name) parent.event_name = m.event_name;
            if (parent.event_category && parent.event_category !== 'Cricket') m.event_category = parent.event_category;
            if (m.event_category && m.event_category !== 'Cricket' && (!parent.event_category || parent.event_category === 'Cricket')) parent.event_category = m.event_category;
        }
    });

    const allMatches = Array.from(matchesMap.values());
    if (allMatches.length === 0) {
        console.error('❌ Failed to fetch any FanCode matches.');
        return false;
    }

    const m3uFile = path.join(dataDir, 'fancode.m3u');
    const jsonFile = path.join(dataDir, 'fancode.json');

    function getMatchesSignature(matches) {
        return matches
            .filter(m => m.stream_url)
            .map(m => `${m.match_id}|${m.stream_url}|${m.match_name || m.title || ''}`)
            .sort()
            .join('\n');
    }

    let hasChanged = true;
    if (fs.existsSync(jsonFile) && fs.existsSync(m3uFile)) {
        try {
            const oldData = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
            const oldSig = getMatchesSignature(oldData.matches || []);
            const newSig = getMatchesSignature(allMatches);

            const hoursSince = (Date.now() - fs.statSync(m3uFile).mtimeMs) / (1000 * 60 * 60);
            if (oldSig === newSig && hoursSince < 6) {
                hasChanged = false;
            }
        } catch (e) {
            hasChanged = true;
        }
    }

    if (!hasChanged) {
        console.log('⚡ FanCode streams & matches are unchanged. Keeping existing playlist.');
        return true;
    }

    // Generate data/fancode.m3u
    let m3uOutput = '#EXTM3U\n';
    m3uOutput += '# Written and Directed by ✨ A R Y A N ✨\n';
    m3uOutput += '# Join us on Telegram: https://t.me/aryanstreams\n';
    m3uOutput += `#DATE:- ${timestamp} IST\n\n`;

    let liveCount = 0;
    allMatches.forEach(m => {
        if (!m.stream_url) return;
        liveCount++;
        const lang = m.language || 'English';
        const cat = m.event_category || 'Cricket';
        const title = m.match_name || m.title || 'Live Match';
        const logo = m.src || 'https://www.fancode.com/skillup-uploads/cms-media/Cricket_Fallback_Old_match-card.jpg';
        m3uOutput += `#EXTINF:-1 tvg-id="${m.match_id}" tvg-name="${title}" tvg-logo="${logo}" tvg-language="${lang}" group-title="${cat}",${lang.substring(0, 3).toUpperCase()} | ${title}\n`;
        m3uOutput += `${m.stream_url}\n`;
    });

    fs.writeFileSync(m3uFile, m3uOutput, 'utf8');
    console.log(`✅ Saved ${liveCount} live streams to ${m3uFile}`);

    // Generate data/fancode.json
    const jsonOutput = {
        Author: 'ARYAN',
        Telegram: 'https://t.me/aryanstreams',
        name: 'Aryan FanCode Live Stream API',
        last_updated: `${timestamp} IST`,
        headers: {
            'User-Agent': 'ReactNativeVideo/9.11.1 (Linux;Android 13) AndroidXMedia3/1.6.1',
            'Referer': 'https://fancode.com/'
        },
        total_matches: allMatches.length,
        live_matches: liveCount,
        matches: allMatches
    };

    fs.writeFileSync(jsonFile, JSON.stringify(jsonOutput, null, 2), 'utf8');
    console.log(`✅ Saved ${allMatches.length} total matches to ${jsonFile}`);

    return true;
}

async function main() {
    const ok = await syncFanCode();
    if (!ok) {
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { syncFanCode };
