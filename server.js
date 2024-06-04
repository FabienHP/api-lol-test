import express from 'express';
import Bottleneck from 'bottleneck';
import axiosInstance from './axiosInstance.js';
import expressListEndpoints from 'express-list-endpoints';
import { createCanvas, loadImage, registerFont } from 'canvas';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const app = express();
const port = 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const championImageCacheDir = path.join(__dirname, 'champion_images');
const checkmarkImagePath = path.join(__dirname, 'checkmark.png');

// Register the Spiegel font
registerFont(path.join(__dirname, 'Spiegel-Regular.ttf'), { family: 'Spiegel' });

// Ensure the cache directory exists
fs.ensureDirSync(championImageCacheDir);

// Create a limiter for Riot's rate limit API
const limiter = new Bottleneck({
  reservoir: 100,
  reservoirRefreshAmount: 100,
  reservoirRefreshInterval: 2 * 60 * 1000,
  maxConcurrent: 1,
  minTime: 50,
});

// Retry limiter for handling rate limiting
limiter.on('failed', async (error, _) => {
  if (error.response && error.response.status === 429) {
    const retryAfter = parseInt(error.response.headers['retry-after']) || 1;
    console.log(`Rate limit exceeded. Retrying after ${retryAfter} seconds.`);
    return retryAfter * 1000;
  }
});

// Connect to MongoDB
const mongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/riot_games';
mongoose.connect(mongoURI);

const matchSchema = new mongoose.Schema({
  puuid: String,
  playerName: String,
  matchId: String,
  data: Object
});

const Match = mongoose.model('Match', matchSchema);

const getAccountByRiotID = async (gameName, tagLine) => {
  return limiter.schedule(() => axiosInstance.get(`https://europe.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${gameName}/${tagLine}`));
};

const getSummonerByPUUID = async (puuid) => {
  return limiter.schedule(() => axiosInstance.get(`https://euw1.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`));
};

const getArenaMatchIds = async (puuid, start) => {
  return limiter.schedule(() => axiosInstance.get(`https://europe.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?startTime=1709247600&queue=1700&start=${start}&count=100`));
};

const getMatchDetails = async (matchId) => {
  const { data } = await limiter.schedule(() => axiosInstance.get(`https://europe.api.riotgames.com/lol/match/v5/matches/${matchId}`));
  return data;
};

const getAllChampions = async () => {
  const { data } = await axios.get('https://ddragon.leagueoflegends.com/cdn/14.10.1/data/en_US/champion.json');
  return Object.keys(data.data).sort();
};

const getCachedChampionImage = async (championName) => {
  const imagePath = path.join(championImageCacheDir, `${championName}.png`);
  if (await fs.pathExists(imagePath)) {
    return loadImage(imagePath);
  } else {
    const url = `https://ddragon.leagueoflegends.com/cdn/14.10.1/img/champion/${championName}.png`;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    await fs.writeFile(imagePath, response.data);
    return loadImage(imagePath);
  }
};

const fetchMatchDetailsWithDB = async (puuid, playerName) => {
  const existingMatches = await Match.find({ puuid }).exec();
  const existingMatchIds = existingMatches.map(match => match.matchId);

  let allMatches = [];
  let start = 0;
  let hasMoreMatches = true;

  while (hasMoreMatches) {
    const { data: matchIds } = await getArenaMatchIds(puuid, start);
    hasMoreMatches = matchIds.length === 100;

    const newMatchIds = matchIds.filter(matchId => !existingMatchIds.includes(matchId));
    if (newMatchIds.length > 0) {
      const matchDetails = await Promise.all(newMatchIds.map(matchId => getMatchDetails(matchId)));
      allMatches.push(...matchDetails);

      const matchDocuments = matchDetails.map(match => ({
        puuid,
        playerName,
        matchId: match.metadata.matchId,
        data: match
      }));

      await Match.insertMany(matchDocuments);
    }

    start += 100;
  }

  return [...existingMatches.map(match => match.data), ...allMatches];
};

// Helper function to generate the HTML with Open Graph metadata
const generateOpenGraphHtml = (url, title, description, imageUrl) => `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:image" content="${imageUrl}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="800" />
    <meta property="og:image:height" content="600" />
    <meta property="og:url" content="${url}" />
    <meta property="og:type" content="website" />
    <title>${title}</title>
  </head>
  <body>
    <h1>${title}</h1>
    <img src="${imageUrl}" alt="${description}" />
  </body>
  </html>
`;

app.get('/getArenaWinRate/:gameName/:tagLine', async (req, res) => {
  try {
    const userAgent = req.headers['user-agent'] || '';
    const { gameName, tagLine } = req.params;
    const imageUrl = `https://arena-api.fabienhp.com/getArenaWinRate/${gameName}/${tagLine}/image`;
    
    if (userAgent.includes('Discordbot')) {
      const html = generateOpenGraphHtml(
        req.originalUrl,
        'Arena Win Rates',
        `View the win rates with teammates in Arena mode for ${gameName}.`,
        imageUrl
      );
      res.send(html);
      return;
    }

    const { data } = await getAccountByRiotID(gameName, tagLine);
    const allMatches = await fetchMatchDetailsWithDB(data.puuid, data.gameName);

    // Create a map to track wins and total games for each teammate
    const teammateStats = new Map();

    for (const match of allMatches) {
      const player = match.info.participants.find(participant => participant.puuid === data.puuid);
      const teammates = match.info.participants.filter(participant => participant.teamId === player.teamId && participant.puuid !== data.puuid);

      for (const teammate of teammates) {
        const stats = teammateStats.get(teammate.puuid) || { puuid: teammate.puuid, summonerName: teammate.summonerName, wins: 0, total: 0 };

        stats.total++;
        if (player.win) {
          stats.wins++;
        }

        teammateStats.set(teammate.puuid, stats);
      }
    }

    // Calculate win rate for each teammate
    const winRates = [];
    const teammateProfiles = new Map();

    for (const stats of teammateStats.values()) {
      if (stats.total > 2) {
        if (!teammateProfiles.has(stats.puuid)) {
          const { data: teammateData } = await getSummonerByPUUID(stats.puuid);
          teammateProfiles.set(stats.puuid, teammateData);
        }
        const profile = teammateProfiles.get(stats.puuid);
        winRates.push({ summonerName: stats.summonerName, profileIconId: profile.profileIconId, winRate: ((stats.wins / stats.total) * 100).toFixed(2), totalGames: stats.total });
      }
    }

    // Sort win rates by total games played
    winRates.sort((a, b) => b.totalGames - a.totalGames);

    // Load teammate icons
    const teammateIcons = await Promise.all(
      winRates.map(async (rate) => {
        const iconUrl = `https://ddragon.leagueoflegends.com/cdn/14.10.1/img/profileicon/${rate.profileIconId}.png`;
        const response = await axios.get(iconUrl, { responseType: 'arraybuffer' });
        return loadImage(Buffer.from(response.data));
      })
    );

    // Generate the image
    const canvasWidth = 800;
    const canvasHeight = 60 * winRates.length + 100;
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#020A13';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Border
    ctx.strokeStyle = '#453716';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, canvasWidth, canvasHeight);

    // Title
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 24px Spiegel';
    ctx.fillText('Teammate Win Rates', canvasWidth / 2 - 100, 50);

    // List win rates
    ctx.font = '20px Spiegel';
    let y = 90;

    winRates.forEach((rate, index) => {
      // Block background
      ctx.fillStyle = '#1A1C21';
      ctx.fillRect(20, y, canvasWidth - 40, 50);

      // Block border
      ctx.strokeStyle = '#4B4B49';
      ctx.lineWidth = 2;
      ctx.strokeRect(20, y, canvasWidth - 40, 50);

      // Icon
      const icon = teammateIcons[index];
      if (icon) {
        ctx.drawImage(icon, 30, y + 5, 40, 40);
      }

      // Text
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.fillText(`${rate.summonerName}: ${rate.winRate}% (${rate.totalGames} games)`, canvasWidth / 2 + 20, y + 30);

      y += 60;
    });

    res.setHeader('Content-Type', 'image/png');
    canvas.createPNGStream().pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred while fetching data from Riot Games API.');
  }
});

app.get('/getChampionsPlayed/:gameName/:tagLine', async (req, res) => {
  try {
    const userAgent = req.headers['user-agent'] || '';
    const { gameName, tagLine } = req.params;
    const imageUrl = `https://arena-api.fabienhp.com/getChampionsPlayed/${gameName}/${tagLine}/image`;

    if (userAgent.includes('Discordbot')) {
      const html = generateOpenGraphHtml(
        req.originalUrl,
        'Champions Played',
        `View the champions played in Arena mode for ${gameName}.`,
        imageUrl
      );
      res.send(html);
      return;
    }

    const { data } = await getAccountByRiotID(gameName, tagLine);
    const allMatches = await fetchMatchDetailsWithDB(data.puuid, data.gameName);

    const championsPlayed = new Set();

    for (const match of allMatches) {
      const player = match.info.participants.find(participant => participant.puuid === data.puuid);
      if (player) {
        championsPlayed.add(player.championName);
      }
    }

    const allChampions = await getAllChampions();

    // Generate the image
    const canvasWidth = 1198;
    const canvasHeight = 828;
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#453716';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.fillStyle = '#020A13';
    ctx.fillRect(2, 2, canvasWidth - 4, canvasHeight - 4);

    const championImages = await Promise.all(
      allChampions.map(name => getCachedChampionImage(name))
    );

    const checkMark = await loadImage(checkmarkImagePath);

    let x = 10;
    let y = 10;
    const imageSize = 64;
    const padding = 10;

    championImages.forEach((image, index) => {
      if (x + imageSize > canvasWidth) {
        x = 10;
        y += imageSize + padding;
      }
      ctx.drawImage(image, x, y, imageSize, imageSize);
      if (championsPlayed.has(allChampions[index])) {
        ctx.fillStyle = '#00000099';
        ctx.fillRect(x, y, imageSize, imageSize);
        ctx.drawImage(checkMark, x + imageSize - 14, y - 6, 20, 20);
      }
      x += imageSize + padding;
    });

    res.setHeader('Content-Type', 'image/png');
    canvas.createPNGStream().pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred while fetching data from Riot Games API.');
  }
});

app.get('/getChampionsWinned/:gameName/:tagLine', async (req, res) => {
  try {
    const userAgent = req.headers['user-agent'] || '';
    const { gameName, tagLine } = req.params;
    const imageUrl = `https://arena-api.fabienhp.com/getChampionsWinned/${gameName}/${tagLine}/image`;

    if (userAgent.includes('Discordbot')) {
      const html = generateOpenGraphHtml(
        req.originalUrl,
        'Champions Winned',
        `View champions winned with ${gameName} in Arena mode.`,
        imageUrl
      );
      res.send(html);
      return;
    }

    const { data } = await getAccountByRiotID(gameName, tagLine);
    const allMatches = await fetchMatchDetailsWithDB(data.puuid, data.gameName);

    const championsWinned = new Set();

    for (const match of allMatches) {
      const player = match.info.participants.find(participant => participant.puuid === data.puuid);
      if (player && player.placement === 1) {
        championsWinned.add(player.championName);
      }
    }

    const allChampions = await getAllChampions();

    // Generate the image
    const canvasWidth = 1198;
    const canvasHeight = 828;
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#453716';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.fillStyle = '#020A13';
    ctx.fillRect(2, 2, canvasWidth - 4, canvasHeight - 4);

    const championImages = await Promise.all(
      allChampions.map(name => getCachedChampionImage(name))
    );

    const checkMark = await loadImage(checkmarkImagePath);

    let x = 10;
    let y = 10;
    const imageSize = 64;
    const padding = 10;

    championImages.forEach((image, index) => {
      if (x + imageSize > canvasWidth) {
        x = 10;
        y += imageSize + padding;
      }
      ctx.drawImage(image, x, y, imageSize, imageSize);
      if (championsWinned.has(allChampions[index])) {
        ctx.fillStyle = '#00000099';
        ctx.fillRect(x, y, imageSize, imageSize);
        ctx.drawImage(checkMark, x + imageSize - 14, y - 6, 20, 20);
      }
      x += imageSize + padding;
    });

    res.setHeader('Content-Type', 'image/png');
    canvas.createPNGStream().pipe(res);
  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred while fetching data from Riot Games API.');
  }
});

app.get('/', (_, res) => {
  const endpoints = expressListEndpoints(app);
  let response = '<h1>Available Routes</h1><ul>';

  endpoints.forEach(endpoint => {
    endpoint.methods.forEach(method => {
      response += `<li><strong>${method}</strong> ${endpoint.path}</li>`;
    });
  });

  response += '</ul>';
  res.send(response);
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
