import { createBrowserRouter } from 'react-router-dom';
// (Importados dentro de App)
import ErrorPage from './ErrorPage';
import LoginView from './views/LoginView';
import App from './App';
import { useAuth } from './context/AuthContext';

function Private({ children }) {
  const { auth, hydrated } = useAuth();
  if (!hydrated) return null; // opcional: spinner
  if (!auth) return <LoginView />;
  return children;
}

export const router = createBrowserRouter([
  { path: '/', element: <LoginView />, errorElement: <ErrorPage /> },
  { path: '/traspasos', element: <Private><App /></Private> },
  { path: '/stock', element: <Private><App /></Private> },
  { path: '*', element: <ErrorPage /> },
]);
