import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-2 items-center">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <h1 className="text-xl font-bold">Page Not Found</h1>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            The page you're looking for doesn't exist.
          </p>
          <Link href="/">
            <Button data-testid="button-go-home">Go to Dashboard</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
