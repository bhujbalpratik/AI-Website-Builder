import { Sandbox } from "@e2b/code-interpreter"
import {
  openai,
  createAgent,
  createTool,
  createNetwork,
  type Tool,
  type Message,
  createState,
} from "@inngest/agent-kit"
import { inngest } from "./client"
import { getSandbox, lastAssistantTextMessageContent } from "./utils"
import z from "zod"
import { FRAGMENT_TITLE_PROMPT, PROMPT, RESPONSE_PROMPT } from "@/prompt"
import { prisma } from "@/lib/db"
import { parsedAgentOutput } from "@/lib/utils"
import { SANDBOX_TIMEOUT } from "./types"

interface AgentState {
  summary: string
  files: { [path: string]: string }
}

export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent" },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    const sandboxId = await step.run("get-sandbox-id", async () => {
      const sandbox = await Sandbox.create("wibe-nextjs-test-2")
      await sandbox.setTimeout(SANDBOX_TIMEOUT)
      return sandbox.sandboxId
    })

    const previousMessages = await step.run(
      "get-previous-messages",
      async () => {
        const formattedMessages: Message[] = []
        const messages = await prisma.message.findMany({
          where: {
            projectId: event.data.projectId,
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 5,
        })
        for (const message of messages) {
          formattedMessages.push({
            type: "text",
            role: message.role === "ASSISTANT" ? "assistant" : "user",
            content: message.content,
          })
        }
        return formattedMessages.reverse()
      }
    )

    // Get previous files metadata (not full content - token efficient!)
    const previousFilesMetadata = await step.run(
      "get-previous-files-metadata",
      async () => {
        try {
          // First check if there are any fragments for this project
          const fragmentCount = await prisma.fragment.count({
            where: {
              message: {
                projectId: event.data.projectId,
              },
            },
          })

          console.log(
            `Found ${fragmentCount} fragments for project ${event.data.projectId}`
          )

          if (fragmentCount === 0) {
            return { exists: false, fileList: [], files: {} }
          }

          // Get the most recent fragment directly - order by message's createdAt
          const lastFragment = await prisma.fragment.findFirst({
            where: {
              message: {
                projectId: event.data.projectId,
                type: "RESULT",
              },
            },
            orderBy: {
              message: {
                createdAt: "desc", // Order by message's createdAt, not fragment's
              },
            },
            include: {
              message: true,
            },
          })

          console.log("Last fragment:", lastFragment?.id)
          console.log("Files:", lastFragment?.files)

          if (!lastFragment || !lastFragment.files) {
            return { exists: false, fileList: [], files: {} }
          }

          // Parse files
          let files: { [path: string]: string } = {}

          if (typeof lastFragment.files === "string") {
            files = JSON.parse(lastFragment.files)
          } else {
            files = lastFragment.files as { [path: string]: string }
          }

          if (Object.keys(files).length === 0) {
            return { exists: false, fileList: [], files: {} }
          }

          const fileList = Object.keys(files).map((path) => ({
            path,
            lines: files[path].split("\n").length,
          }))

          console.log(`Loaded ${fileList.length} files from previous fragment`)

          return {
            exists: true,
            fileList,
            files,
          }
        } catch (error) {
          console.error("Error fetching previous files:", error)
          return { exists: false, fileList: [], files: {} }
        }
      }
    )

    const state = createState<AgentState>(
      {
        summary: "",
        files: {}, // Start empty, agent reads what it needs
      },
      {
        messages: previousMessages,
      }
    )

    const codeAgent = createAgent<AgentState>({
      name: "code-agent",
      description: "An Expert Coding Agent",
      system: PROMPT,
      model: openai({
        model: "gpt-4.1",
        defaultParameters: { temperature: 0.1 },
      }),
      tools: [
        createTool({
          name: "terminal",
          description: "Use the terminal to run commands",
          parameters: z.object({
            command: z.string(),
          }),
          handler: async ({ command }, { step }) => {
            return await step?.run("terminal", async () => {
              const buffers = { stdout: "", stderr: "" }
              try {
                const sandbox = await getSandbox(sandboxId)
                const result = await sandbox.commands.run(command, {
                  onStdout: (data: string) => {
                    buffers.stdout += data
                  },
                  onStderr: (data: string) => {
                    buffers.stderr += data
                  },
                })
                return result.stdout
              } catch (error) {
                console.log(
                  `Command Failed : ${error} \n stdout : ${buffers.stdout} \n stderr : ${buffers.stderr}`
                )
                return `Command Failed : ${error} \n stdout : ${buffers.stdout} \n stderr : ${buffers.stderr}`
              }
            })
          },
        }),
        createTool({
          name: "createOrUpdateFiles",
          description: "Create or update files in sandbox",
          parameters: z.object({
            files: z.array(z.object({ path: z.string(), content: z.string() })),
          }),
          handler: async (
            { files },
            { step, network }: Tool.Options<AgentState>
          ) => {
            const newFiles = await step?.run(
              "createOrUpdateFiles",
              async () => {
                try {
                  console.log(
                    `[createOrUpdateFiles] Agent updating files: ${files
                      .map((f) => f.path)
                      .join(", ")}`
                  )
                  const updatedFiles = network.state.data.files || {}
                  const sandbox = await getSandbox(sandboxId)
                  for (const file of files) {
                    await sandbox.files.write(file.path, file.content)
                    updatedFiles[file.path] = file.content
                  }
                  return updatedFiles
                } catch (error) {
                  return "Error : " + error
                }
              }
            )
            if (typeof newFiles === "object") {
              network.state.data.files = newFiles
            }
          },
        }),
        createTool({
          name: "readFiles",
          description:
            "Read files from the project. MANDATORY: You MUST use this tool to read any existing files before modifying them. This is required for existing projects to avoid recreating everything from scratch.",
          parameters: z.object({
            files: z.array(z.string()),
          }),
          handler: async ({ files }, { step }) => {
            return await step?.run("readFiles", async () => {
              try {
                console.log(
                  `[readFiles] Agent requesting files: ${files.join(", ")}`
                )
                const contents: Array<{ path: string; content: string }> = []

                for (const file of files) {
                  // First check if file exists in previous state
                  if (
                    previousFilesMetadata.exists &&
                    previousFilesMetadata.files[file]
                  ) {
                    contents.push({
                      path: file,
                      content: previousFilesMetadata.files[file],
                    })
                  } else {
                    // Otherwise read from sandbox
                    try {
                      const sandbox = await getSandbox(sandboxId)
                      const content = await sandbox.files.read(file)
                      contents.push({ path: file, content })
                    } catch {
                      contents.push({
                        path: file,
                        content: `Error reading ${file}: File not found`,
                      })
                    }
                  }
                }

                return JSON.stringify(contents)
              } catch (error) {
                return "Error : " + error
              }
            })
          },
        }),
      ],
      lifecycle: {
        onResponse: async ({ result, network }) => {
          const lastAssistantMessageText =
            lastAssistantTextMessageContent(result)
          if (lastAssistantMessageText && network) {
            if (lastAssistantMessageText.includes("<task_summary>")) {
              network.state.data.summary = lastAssistantMessageText
            }
          }
          return result
        },
      },
    })

    const network = createNetwork<AgentState>({
      name: "coding-agent-network",
      agents: [codeAgent],
      maxIter: 15,
      defaultState: state,
      router: async ({ network }) => {
        const summary = network.state.data.summary
        if (summary) {
          return
        }
        return codeAgent
      },
    })

    // Add context about existing files (token-efficient)
    let userMessage = event.data.value

    if (
      previousFilesMetadata.exists &&
      previousFilesMetadata.fileList.length > 0
    ) {
      const fileListStr = previousFilesMetadata.fileList
        .map((f) => `  - ${f.path} (~${f.lines} lines)`)
        .join("\n")

      userMessage = `🔄 EXISTING PROJECT - MODIFICATION MODE

CURRENT PROJECT FILES:
${fileListStr}

⚠️ CRITICAL INSTRUCTIONS:
1. This is an EXISTING project, NOT a new build
2. FIRST: Use readFiles tool to read files you need to modify
3. ONLY modify what's necessary for the user's request
4. DO NOT recreate files that don't need changes
5. All unchanged files will be automatically preserved

📝 USER REQUEST:
${event.data.value}

Remember: Read first, then modify only what's needed!`
    }
    console.log("=== MESSAGE SENT TO AGENT ===")
    console.log(userMessage)
    console.log("=== END MESSAGE ===")

    const result = await network.run(userMessage, { state })

    const fragmentTitleGenerator = createAgent({
      name: "fragment-title-generator",
      description: "A Fragment Title Generator",
      system: FRAGMENT_TITLE_PROMPT,
      model: openai({
        model: "gpt-3.5-turbo",
        defaultParameters: { temperature: 0.1 },
      }),
    })

    const responsegenerator = createAgent({
      name: "response-generator",
      description: "A Response Generator",
      system: RESPONSE_PROMPT,
      model: openai({
        model: "gpt-3.5-turbo",
        defaultParameters: { temperature: 0.1 },
      }),
    })

    const { output: fragmentTitleOutput } = await fragmentTitleGenerator.run(
      result.state.data.summary
    )

    const { output: responseOutput } = await responsegenerator.run(
      result.state.data.summary
    )

    const isError =
      !result.state.data.summary ||
      Object.keys(result.state.data.files || {}).length === 0

    const sandboxUrl = await step.run("get-sandbox-url", async () => {
      const sandbox = await getSandbox(sandboxId)
      const host = sandbox.getHost(3000)
      return `https://${host}`
    })

    await step.run("save-result", async () => {
      if (isError) {
        return await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: "Something went wrong! Please try again.",
            role: "ASSISTANT",
            type: "ERROR",
          },
        })
      }

      // Merge previous files with new/modified files
      const finalFiles = {
        ...previousFilesMetadata.files, // All previous files
        ...result.state.data.files, // Override with new/modified files
      }

      await prisma.project.update({
        where: {
          id: event.data.projectId,
        },
        data: {
          name: parsedAgentOutput(fragmentTitleOutput),
        },
      })

      return await prisma.message.create({
        data: {
          projectId: event.data.projectId,
          content: parsedAgentOutput(responseOutput),
          role: "ASSISTANT",
          type: "RESULT",
          fragment: {
            create: {
              sandboxUrl,
              title: parsedAgentOutput(fragmentTitleOutput),
              files: finalFiles, // Save merged files
            },
          },
        },
      })
    })

    return {
      url: sandboxUrl,
      title: "Fragment",
      files: result.state.data.files,
      summary: result.state.data.summary,
    }
  }
)
