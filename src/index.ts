import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";

export class MyMCP extends McpAgent {
  private supabase: any;
  private genAI: any;
  private rateLimits: Map<string, { count: number; timestamp: number }>;

  server = new McpServer({
    name: "Code to Flowchart Converter",
    version: "1.0.0",
    description: "Converts code to interactive Mermaid flowcharts",
    publisher: "Bolt",
    homepage: "https://projectbolt.com"
  });

  constructor(state: DurableObjectState, env: any) {
    super(state, env);
    this.rateLimits = new Map();
    
    // Initialize Supabase client
    this.supabase = createClient(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      { 
        auth: { persistSession: false },
        global: { 
          headers: { 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
        },
      }
    );
    
    // Initialize Gemini AI
    this.genAI = new GoogleGenerativeAI(env.VITE_GEMINI_API_KEY);
  }

  private checkRateLimit(email: string) {
    const now = Date.now();
    const userLimit = this.rateLimits.get(email) || { count: 0, timestamp: now };
    
    if (now - userLimit.timestamp > 60000) {
      userLimit.count = 0;
      userLimit.timestamp = now;
    }
    
    if (userLimit.count >= 10) {
      throw new Error("Rate limit exceeded. Please try again in a minute.");
    }
    
    userLimit.count++;
    this.rateLimits.set(email, userLimit);
  }

  private async checkSubscription(email: string) {
    const { data, error } = await this.supabase
      .from("users")
      .select("turns")
      .eq("email", email)
      .single();
    return !error && data && data.turns > 0;
  }

  private async decrementTurns(email: string) {
    const { data: userData, error: fetchError } = await this.supabase
      .from("users")
      .select("turns")
      .eq("email", email)
      .single();

    if (fetchError) throw new Error("Failed to fetch user turns");
    
    const { error: updateError } = await this.supabase
      .from("users")
      .update({ 
        turns: userData.turns - 1,
        updated_at: new Date().toISOString()
      })
      .eq("email", email);

    if (updateError) throw new Error("Failed to update turns");
  }

  private async generateMermaidFlowchart(code: string) {
    if (!code.trim()) throw new Error("Please provide valid code to convert.");
    
    try {
      const model = this.genAI.getGenerativeModel({
        model: "gemini-2.0-flash",
        generationConfig: { 
          temperature: 0.5,
          maxOutputTokens: 5000,
          topK: 40,
          topP: 0.95,
        },
      });

      const systemPrompt = `
        For the given code, generate an HTML page that uses the Mermaid library to create an appropriate flowchart along with zoom and pan controls.
      The flowchart should be clear and easy to understand, with appropriate labels and connections.
      ** Do not give anything else. Just give the code. **
      ** The code should be a complete HTML page. **
      Example:
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <title>Enhanced Mermaid Flowchart</title>
          <style>
              body { margin: 0; font-family: Arial, sans-serif; display: flex; flex-direction: column; height: 100vh; }
              #controls { padding: 10px; background: #f0f0f0; border-bottom: 1px solid #ccc; display: flex; gap: 10px; }
              #controls button { padding: 5px 10px; cursor: pointer; }
              #mermaidChart { flex: 1; overflow: hidden; }
          </style>
      </head>
      <body>
          <div id="controls">
              <button id="zoomIn">+</button>
              <button id="zoomOut">-</button>
              <button id="reset">Reset</button>
          </div>
          <div id="mermaidChart"></div>
          <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
          <script src="https://bumbu.me/svg-pan-zoom/dist/svg-pan-zoom.min.js"></script>
          <script>
              mermaid.initialize({ startOnLoad: false, flowchart: { useMaxWidth: false } });
              const graphDefinition = \`graph TD\n    A[Start] --> B[End]\`;
              async function renderDiagram() {
                  const element = document.getElementById('mermaidChart');
                  const { svg } = await mermaid.render('graphDiv', graphDefinition);
                  element.innerHTML = svg.replace(/max-width:[0-9.]*px;/i, '');
                  const panZoom = svgPanZoom('#graphDiv', { zoomEnabled: true });
              }
              window.addEventListener('load', renderDiagram);
          </script>
      </body>
      </html>
      Now, convert this code:
      ${code}
    `;

      const result = await model.generateContent(systemPrompt);
      const responseText = await result.response.text();
      return responseText.replace(/```html\n?/g, "").replace(/```/g, "").trim();
    } catch (error) {
      console.error('Gemini API error:', error);
      throw new Error("Failed to generate flowchart. Please try again.");
    }
  }

  async init() {
    this.server.tool(
      "code_to_flowchart",
      {
        code: z.string()
          .min(1, "Code cannot be empty")
          .max(5000, "Code is too long")
          .describe("The code to convert to a flowchart"),
        gmail: z.string()
          .email("Invalid email format")
          .describe("User Gmail for subscription check"),
      },
      async ({ code, gmail }) => {
        try {
          this.checkRateLimit(gmail);
          
          const isSubscribed = await this.checkSubscription(gmail);
          if (!isSubscribed) {
            throw new Error("User not subscribed or out of turns");
          }
          
          const html = await this.generateMermaidFlowchart(code);
          
          await this.decrementTurns(gmail);
          
          return { 
            content: [{ type: "text", text: html }],
            metadata: {
              generated: new Date().toISOString(),
              codeLength: code.length,
            }
          };
        } catch (error) {
          console.error('Tool execution error:', error);
          throw error;
        }
      }
    );
  }
}

export default {
  fetch: async (request: Request, env: any, ctx: ExecutionContext) => {
    const url = new URL(request.url);
    if (url.pathname === "/sse") {
      const id = env.MY_MCP.idFromName("default");
      const mcpDO = env.MY_MCP.get(id);
      return mcpDO.fetch(request, env, ctx);
    }
    return new Response("Not Found", { status: 404 });
  }
};
