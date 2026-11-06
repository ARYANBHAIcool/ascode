const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

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
    return String(value || '').trim().split('|')[0].trim().replace(/[,\s]+$/g, '');
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

function cleanCategory(cat) {
    if (!cat) return 'Sports';
    const c = String(cat).replace(/^fancode-/i, '').trim();
    if (!c) return 'Sports';
    return c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
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
            cur.language = langMatch ? langMatch[1] : '';
            const groupMatch = line.match(/group-title="([^"]+)"/i);
            cur.event_category = cleanCategory(groupMatch ? groupMatch[1] : 'Sports');
            const commaSplit = line.split(',');
            if (commaSplit.length > 1 && !cur.title) {
                cur.title = commaSplit[commaSplit.length - 1].trim();
                cur.match_name = cur.title;
            }
        } else if (line.startsWith('http') && cur) {
            if (!cur.match_id) {
                const urlIdMatch = line.match(/mumbai\/([0-9a-zA-Z]+)_/i);
                if (urlIdMatch) cur.match_id = urlIdMatch[1];
            }
            if (!cur.language) {
                const urlLangMatch = line.match(/mumbai\/[0-9a-zA-Z]+_([a-zA-Z]+)_hls/i);
                if (urlLangMatch) {
                    const l = urlLangMatch[1];
                    cur.language = l.charAt(0).toUpperCase() + l.slice(1).toLowerCase();
                } else {
                    cur.language = 'English';
                }
            }
            cur.stream_url = toDaiUrl(line);
            cur.status = 'LIVE';
            cur.startTime = cur.startTime || 'Live Now';

            if (cur.match_id) {
                const lang = (cur.language || 'English').trim();
                const langLower = lang.toLowerCase();
                const langCode = langLower.substring(0, 3);
                
                if (langLower !== 'english' && !cur.match_id.includes('_')) {
                    cur.match_id = `${cur.match_id}_${langCode}`;
                }
                if (!cur.title.toLowerCase().includes(`[${langLower}]`)) {
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

function normalizeTitle(t) {
    return String(t || '')
        .toLowerCase()
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\([^\)]*\)/g, '')
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titlesMatch(a, b) {
    const na = normalizeTitle(a);
    const nb = normalizeTitle(b);
    if (!na || !nb) return false;
    if (na === nb || na.includes(nb) || nb.includes(na)) return true;
    
    const wordsA = na.split(' ').filter(w => w.length > 3);
    const wordsB = nb.split(' ').filter(w => w.length > 3);
    if (wordsA.length && wordsB.length) {
        const overlap = wordsA.filter(w => wordsB.includes(w));
        if (overlap.length >= 2 || (overlap.length === 1 && (wordsA.length === 1 || wordsB.length === 1))) {
            return true;
        }
    }
    return false;
}

function parseFanCodeDate(str) {
    if (!str || typeof str !== 'string') return null;
    const m = str.match(/(\d+):(\d+):(\d+)\s*(AM|PM)\s*(\d+)-(\d+)-(\d+)/i);
    if (!m) return null;
    let [_, hh, mm, ss, ap, day, mon, yr] = m;
    let h = parseInt(hh, 10);
    if (ap.toUpperCase() === 'PM' && h < 12) h += 12;
    if (ap.toUpperCase() === 'AM' && h === 12) h = 0;
    // IST is UTC + 5:30
    return new Date(Date.UTC(parseInt(yr, 10), parseInt(mon, 10) - 1, parseInt(day, 10), h - 5, parseInt(mm, 10) - 30, parseInt(ss, 10)));
}

async function syncFanCode() {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    console.log(`[${timestamp} IST] 🔄 Starting AryanStreams FanCode Multi-Source Ingestion Engine...`);

    const matchesMap = new Map();
    const liveStreamsPool = [];

    // 1. Fetch from doctor-8trange active M3U
    try {
        console.log('Fetching doctor-8trange zyphx8 fancode.m3u...');
        const m3uText = await fetchEndpoint('https://raw.githubusercontent.com/doctor-8trange/zyphx8/main/data/fancode.m3u');
        const m3uMatches = parseM3U(m3uText);
        console.log(`Loaded ${m3uMatches.length} active streams from doctor-8trange.`);
        m3uMatches.forEach(m => {
            const uniqueId = String(m.match_id).toLowerCase();
            matchesMap.set(uniqueId, m);
            liveStreamsPool.push(m);
        });
    } catch (err) {
        console.warn('⚠️ Could not fetch doctor-8trange M3U:', err.message);
    }

    // 2. Fetch from sportlive18 DAI M3U (fancode2.m3u)
    try {
        console.log('Fetching sportlive18 fancode2.m3u (DAI)...');
        const sl2Text = await fetchEndpoint('https://raw.githubusercontent.com/sportlive18/Fancode-New-Auto-Update/main/fancode2.m3u');
        const sl2Matches = parseM3U(sl2Text);
        console.log(`Loaded ${sl2Matches.length} streams from sportlive18 DAI.`);
        sl2Matches.forEach(m => {
            const uniqueId = String(m.match_id).toLowerCase();
            if (!matchesMap.has(uniqueId)) {
                matchesMap.set(uniqueId, m);
            }
            liveStreamsPool.push(m);
        });
    } catch (err) {
        console.warn('⚠️ Could not fetch sportlive18 fancode2 M3U:', err.message);
    }

    // 3. Fetch from sportlive18 direct streams (fancode.m3u - 1080p & fancode3.m3u - 720p)
    try {
        console.log('Fetching sportlive18 fancode.m3u (1080p)...');
        const sl1Text = await fetchEndpoint('https://raw.githubusercontent.com/sportlive18/Fancode-New-Auto-Update/main/fancode.m3u');
        const sl1Matches = parseM3U(sl1Text);
        console.log(`Loaded ${sl1Matches.length} streams from sportlive18 1080p.`);
        sl1Matches.forEach(m => {
            const uniqueId = String(m.match_id).toLowerCase();
            if (!matchesMap.has(uniqueId)) {
                matchesMap.set(uniqueId, m);
            }
            liveStreamsPool.push(m);
        });
    } catch (err) {
        console.warn('⚠️ Could not fetch sportlive18 fancode M3U:', err.message);
    }

    // 4. Fetch from byte-capsule JSON
    try {
        console.log('Fetching byte-capsule JSON...');
        const bcText = await fetchEndpoint('https://raw.githubusercontent.com/byte-capsule/FanCode-Hls-Fetcher/main/Fancode_hls_m3u8.Json');
        const bcData = JSON.parse(bcText);
        const bcMatches = bcData.matches || [];
        console.log(`Loaded ${bcMatches.length} streams from byte-capsule.`);
        bcMatches.forEach(bm => {
            const rawId = String(bm.match_id || '').toLowerCase();
            if (!rawId) return;
            const streamUrl = toDaiUrl(bm.stream_link || bm.adfree_url || bm.dai_url || '');
            if (!streamUrl) return;

            const entry = {
                match_id: rawId,
                title: bm.match_name || `${bm.team_1 || ''} vs ${bm.team_2 || ''}`.trim() || 'Live Match',
                match_name: bm.match_name || 'Live Match',
                src: bm.banner || bm.team_1_flag || '',
                event_category: cleanCategory(bm.event_catagory || 'Cricket'),
                event_name: bm.event_name || '',
                language: 'English',
                team_1: bm.team_1 || '',
                team_2: bm.team_2 || '',
                status: 'LIVE',
                startTime: 'Live Now',
                stream_url: streamUrl
            };
            if (!matchesMap.has(rawId)) {
                matchesMap.set(rawId, entry);
            }
            liveStreamsPool.push(entry);
        });
    } catch (err) {
        console.warn('⚠️ Could not fetch byte-capsule JSON:', err.message);
    }

    // 5. Fetch from drmlive fancode.json (Match Schedules & Telemetry)
    try {
        console.log('Fetching drmlive fancode.json...');
        const jsonText = await fetchEndpoint('https://raw.githubusercontent.com/drmlive/fancode-live-events/main/fancode.json');
        const jsonData = JSON.parse(jsonText);
        const jsonMatches = jsonData.matches || jsonData || [];
        console.log(`Loaded ${jsonMatches.length} matches from drmlive.`);

        jsonMatches.forEach(jm => {
            const rawId = String(jm.match_id || '').toLowerCase();
            const baseId = rawId.split('_')[0];
            
            let targetKey = matchesMap.has(rawId) ? rawId : (matchesMap.has(baseId) ? baseId : null);

            // Fuzzy title matching across active streams
            if (!targetKey) {
                const jmTitle = jm.title || jm.match_name || '';
                for (const [k, v] of matchesMap.entries()) {
                    if (v.stream_url && titlesMatch(jmTitle, v.title || v.match_name)) {
                        targetKey = k;
                        break;
                    }
                }
            }

            const rawStream = jm.adfree_url || jm.dai_url || jm.url || '';
            const streamUrl = toDaiUrl(rawStream);

            if (targetKey && matchesMap.has(targetKey)) {
                const existing = matchesMap.get(targetKey);
                if (!existing.startTime && jm.startTime) existing.startTime = jm.startTime;
                if (!existing.team_1 && jm.team_1) existing.team_1 = jm.team_1;
                if (!existing.team_2 && jm.team_2) existing.team_2 = jm.team_2;
                if (!existing.event_name && (jm.event_name || jm.tournament)) existing.event_name = jm.event_name || jm.tournament;
                if (!existing.src && jm.src) existing.src = jm.src;
                if (streamUrl && !existing.stream_url) existing.stream_url = streamUrl;
                if (!existing.event_category && jm.event_category) existing.event_category = cleanCategory(jm.event_category);
            } else {
                let matchedStream = streamUrl;
                if (!matchedStream) {
                    const matchInPool = liveStreamsPool.find(s => 
                        String(s.match_id).toLowerCase() === rawId ||
                        String(s.match_id).toLowerCase() === baseId ||
                        titlesMatch(s.title || s.match_name, jm.title || jm.match_name)
                    );
                    if (matchInPool && matchInPool.stream_url) {
                        matchedStream = matchInPool.stream_url;
                    }
                }

                matchesMap.set(rawId, {
                    match_id: jm.match_id || rawId,
                    title: jm.title || jm.match_name || 'Live Match',
                    match_name: jm.match_name || jm.title || 'Live Match',
                    src: jm.src || jm.image || '',
                    event_category: cleanCategory(jm.event_category || jm.category || 'Sports'),
                    event_name: jm.event_name || jm.tournament || '',
                    language: jm.language || (rawId.includes('_hin') ? 'Hindi' : (rawId.includes('_tam') ? 'Tamil' : 'English')),
                    startTime: jm.startTime || (matchedStream ? 'Live Now' : ''),
                    status: jm.status || (matchedStream ? 'LIVE' : 'UPCOMING'),
                    stream_url: matchedStream || ''
                });
            }
        });
    } catch (err) {
        console.warn('⚠️ Could not fetch drmlive JSON:', err.message);
    }

    // 6. Enrich multi-language streams with parent / sibling metadata
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
            if (parent.event_category) m.event_category = cleanCategory(parent.event_category);
        }
    });

    // 7. Filter out old ended matches (> 6 hours ago with no active stream)
    const now = Date.now();
    const cleanedMatches = [];
    const titleCounts = {};

    for (const m of matchesMap.values()) {
        m.event_category = cleanCategory(m.event_category);

        // Always keep matches that have an active stream
        if (m.stream_url) {
            m.status = 'LIVE';
            if (!m.startTime) m.startTime = 'Live Now';
            cleanedMatches.push(m);
            continue;
        }

        // Check if start time is over 6 hours ago and stream has ended/never started
        if (m.startTime) {
            const dObj = parseFanCodeDate(m.startTime);
            if (dObj) {
                const diffHours = (now - dObj.getTime()) / (1000 * 3600);
                if (diffHours > 6) {
                    console.log(`Purging expired match (${diffHours.toFixed(1)}h old):`, m.title);
                    continue;
                }
            }
        }

        cleanedMatches.push(m);
    }

    // 8. Deduplicate and disambiguate duplicate titles (e.g. Court 1 / Court 2)
    cleanedMatches.forEach(m => {
        const rawT = (m.match_name || m.title || '').trim();
        titleCounts[rawT] = (titleCounts[rawT] || 0) + 1;
    });

    const seenCounts = {};
    cleanedMatches.forEach(m => {
        const rawT = (m.match_name || m.title || '').trim();
        if (titleCounts[rawT] > 1 && !m.match_id.includes('_')) {
            seenCounts[rawT] = (seenCounts[rawT] || 0) + 1;
            const disambig = ` [Feed ${seenCounts[rawT]}]`;
            if (!m.title.includes('Feed')) {
                m.title = `${m.title}${disambig}`;
                m.match_name = `${m.match_name || m.title}${disambig}`;
            }
        }
    });

    if (cleanedMatches.length === 0) {
        console.error('❌ Failed to fetch any FanCode matches.');
        return false;
    }

    // Pre-resolve master_m3u8 for live streams
    console.log('Resolving master playlists for live streams...');
    await Promise.allSettled(cleanedMatches.map(async (m) => {
        if (m.stream_url && m.stream_url.includes('.m3u8')) {
            try {
                const clean = cleanStreamUrl(m.stream_url);
                const mText = await fetchEndpoint(clean);
                if (mText && mText.includes('#EXT-X-STREAM-INF')) {
                    m.master_m3u8 = mText;
                }
            } catch (_) {}
        }
    }));

    const m3uFile = path.join(dataDir, 'fancode.m3u');
    const jsonFile = path.join(dataDir, 'fancode.json');

    // Generate data/fancode.m3u
    let m3uOutput = '#EXTM3U\n';
    m3uOutput += '# ⚡ ARYANSTREAMS • FANCODE PRO LIVE HUB ⚡\n';
    m3uOutput += '# Official Telegram: https://t.me/aryanstreams\n';
    m3uOutput += `# Updated: ${timestamp} IST\n\n`;

    let liveCount = 0;
    cleanedMatches.forEach(m => {
        if (!m.stream_url) return;
        liveCount++;
        const lang = m.language || 'English';
        const cat = m.event_category || 'Sports';
        const title = m.match_name || m.title || 'Live Match';
        const logo = m.src || 'https://www.fancode.com/skillup-uploads/cms-media/Cricket_Fallback_Old_match-card.jpg';
        m3uOutput += `#EXTINF:-1 tvg-id="${m.match_id}" tvg-name="${title}" tvg-logo="${logo}" tvg-language="${lang}" group-title="${cat}",${lang.substring(0, 3).toUpperCase()} | ${title}\n`;
        m3uOutput += `${m.stream_url}\n`;
    });

    fs.writeFileSync(m3uFile, m3uOutput, 'utf8');
    console.log(`✅ Saved ${liveCount} live streams to ${m3uFile}`);

    // Generate data/fancode.json
    const jsonOutput = {
        Author: '✨ ARYAN ✨',
        Brand: 'AryanStreams',
        Telegram: 'https://t.me/aryanstreams',
        name: 'AryanStreams FanCode Live API',
        last_updated: `${timestamp} IST`,
        headers: {
            'User-Agent': 'ReactNativeVideo/9.11.1 (Linux;Android 13) AndroidXMedia3/1.6.1',
            'Referer': 'https://fancode.com/'
        },
        total_matches: cleanedMatches.length,
        live_matches: liveCount,
        matches: cleanedMatches
    };

    fs.writeFileSync(jsonFile, JSON.stringify(jsonOutput, null, 2), 'utf8');
    console.log(`✅ Saved ${cleanedMatches.length} total matches to ${jsonFile}`);

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
