import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { SharedApp } from './shared';

createRoot(document.getElementById('root')!).render(<StrictMode><SharedApp/></StrictMode>);
