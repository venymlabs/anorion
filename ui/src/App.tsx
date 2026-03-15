import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import Layout from '@/components/Layout'
import Dashboard from '@/pages/Dashboard'
import { AgentsPage, AgentDetailPage } from '@/pages/Agents'
import { SessionsPage, SessionDetailPage } from '@/pages/Sessions'
import ToolsPage from '@/pages/Tools'
import JobsPage from '@/pages/Jobs'
import ConfigPage from '@/pages/Config'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 30000,
    },
  },
})

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/:agentId" element={<AgentDetailPage />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
            <Route path="/tools" element={<ToolsPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/config" element={<ConfigPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
