# Disabled Apollo Playground compatibility module

`@nestjs/apollo` imports the deprecated Apollo Playground package even when the
application does not enable Playground. The published package peers on Apollo
Server 4, which would keep an end-of-life and vulnerable server in the
production dependency graph.

This private compatibility module preserves only the imported symbol and fails
closed if it is called. Applications use Nest Apollo's supported `graphiql`
option for non-production development instead.
