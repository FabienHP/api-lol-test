import axios from 'axios';
import { config } from 'dotenv';
config();

const axiosInstance = axios.create({
  headers: {
    'X-Riot-Token': process.env.RIOT_API_KEY,
    'Content-Type': 'application/json',
  },
});

export default axiosInstance;
