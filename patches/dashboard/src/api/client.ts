import axios from 'axios';
import { supabase } from '../config/supabase';

// Only VITE_API_BASE_URL, VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (auth only) remain in the frontend.
const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api',
});

apiClient.interceptors.request.use(async (config) => {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) config.headers.Authorization = `Bearer ${session.access_token}`;
  return config;
});

apiClient.interceptors.response.use(
  (r) => r,
  async (error) => {
    if (error.response?.status === 401) await supabase.auth.signOut();
    return Promise.reject(new Error(error.response?.data?.error || error.message));
  },
);

export default apiClient;
