import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { useTheme } from "@/components/kit/theme"

const Toaster = ({ ...props }: ToasterProps) => {
  // Follows the theme as it changes, not only the one it mounted in.
  const theme = useTheme().dark ? "dark" : "light"

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // Above the phone's tab bar, and clear of the page's bottom edge on a desktop.
      offset={{ bottom: 20, right: 20 }}
      mobileOffset={{ bottom: "calc(4.25rem + env(safe-area-inset-bottom))", left: 12, right: 12 }}
      toastOptions={{
        classNames: {
          toast: "!gap-3 !border-border !shadow-lg",
          title: "!text-body !font-medium",
          description: "!text-caption !text-muted-foreground",
          // The toast's one action is the standard small button, not sonner's own chip.
          actionButton: "!h-7 !rounded-md !bg-primary !px-2.5 !text-caption !font-medium !text-primary-foreground hover:!bg-primary/90 focus-visible:!outline-2 focus-visible:!outline-offset-2 focus-visible:!outline-ring",
          cancelButton: "!h-7 !rounded-md !bg-transparent !px-2.5 !text-caption !font-medium !text-foreground hover:!bg-muted",
        },
      }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
