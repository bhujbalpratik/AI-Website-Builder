import { ProjectForm } from "@/modules/home/ui/components/project-form"
import { ProjectsList } from "@/modules/home/ui/components/projects-list"
import Image from "next/image"

const Page = () => {
  return (
    <div className="flex flex-col max-w-5xl mx-auto w-full overflow-x-clip">
      <section className="space-y-6 py-[16vh] 2xl:py-48">
        <div className="flex flex-col items-center space-y-2">
          <Image
            src="/logo.png"
            alt="wibe"
            width={70}
            height={70}
            className="hidden md:block"
          />
          <h1 className="text-2xl md:text-5xl font-bold text-center">
            Build Something with Wibe
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground text-center mt-2">
            Create Apps and websites by chatting with AI{" "}
          </p>
        </div>
        <div className="max-w-3xl mx-auto w-full">
          <ProjectForm />
        </div>
      </section>
      <ProjectsList />
    </div>
  )
}
export default Page
