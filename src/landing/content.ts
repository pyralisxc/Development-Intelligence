/** Public landing content. Edit these fields to change the site's language and roadmap. */
export const landing = {
  requestEmail: 'Cameron.r.locke96@gmail.com',
  hero: { eyebrow: 'DEVELOPMENT INTELLIGENCE', title: 'See your software more clearly.', text: 'A connected environment for understanding code, tracing relationships, and following the evidence—built for the people and agents working on your projects.' },
  principles: [
    { title: 'Evidence has a source', text: 'Follow findings back to the source and context that support them.' },
    { title: 'Intelligence without invention', text: 'Deterministic analysis builds intelligence that stands on its own. AI can use it without inventing the evidence.' },
    { title: 'Uncertainty stays visible', text: 'A candidate, a missing observation, and a proven relationship are not the same thing.' },
    { title: 'One connected understanding', text: 'The graph, source, questions, and evidence are ways into a shared investigation.' },
  ],
  exhibits: [
    { id: 'source', label: '01 / SOURCE INTELLIGENCE', title: 'Start with the source. Follow what it connects.', text: 'DI builds an evidence-backed model of a selected source state: the parts of a project, their relationships, and the context that supports them. Source-level understanding is our focus today.', capabilities: [
      {title:'Code becomes connected knowledge', text:'Explore files, symbols, declarations, and supported relationships in the context of a selected source state.'},
      {title:'Language-aware analysis', text:'Parsers, compilers, and indexers can contribute source-grounded evidence. Support and precision differ by language and relationship.'},
      {title:'Evidence, not guesswork', text:'Trace a finding to its supporting source, and keep partial coverage and unresolved relationships visible.'},
      {title:'Exact state matters', text:'A committed revision and local working files describe different source states. The identity of the state belongs with the answer.'},
    ]},
    { id:'workspace', label:'02 / THE WORKSPACE', title:'An environment for understanding.', text:'Ask a question, follow its connections through the graph, and inspect the source and evidence behind what you find—all within the context of your project.', capabilities:[
      {title:'Explore and investigate', text:'Follow connections visually, inspect source, and ask questions of the selected intelligence.'},
      {title:'People and agents', text:'The Workbench and MCP offer different ways to use DI’s underlying intelligence.'},
      {title:'A deeper workspace ahead', text:'We’re exploring a more integrated IDE-like experience, including direct source editing and clear graph freshness.'},
      {title:'Your investigation, your context', text:'Projects, selected graphs, connected computers, and layout are part of the workspace experience.'},
    ]},
    { id:'architecture', label:'03 / RULES & INVESTIGATION', title:'Give your architecture a voice.', text:'Connect expectations about your software to the evidence in its source. DI already supports evaluating explicit expectations; richer architectural rules and auditing are part of the direction ahead.', capabilities:[
      {title:'Expectations and parity', text:'Compare explicit expectations with observed intelligence and keep unproven results distinct.'},
      {title:'Architectural and custom rules', text:'Explore rules that apply to a codebase and illuminate the parts and relationships they affect.'},
      {title:'Deeper audits', text:'Bring evidence, architecture, changes, and coverage together in a more connected investigation.'},
      {title:'Understand change', text:'Compare source states and explore the areas connected to changes, with evidence and limits in view.'},
    ]},
    { id:'environment', label:'04 / YOUR ENVIRONMENT', title:'Choose where the work happens.', text:'Source, compute, graph storage, and the service that reads it are distinct parts of an investigation. DI is being built to make those choices understandable across connected and local environments.', capabilities:[
      {title:'Local and connected source', text:'Work with a local project or an authorized connected repository, keeping its selected state clear.'},
      {title:'Computers and analysis', text:'A linked computer or supported hosted environment can play a role in building intelligence.'},
      {title:'Graph storage', text:'The saved intelligence has its own location and lifecycle, distinct from the original source.'},
      {title:'Transfers and availability', text:'Explore how intelligence moves between supported locations and remains available to the places that use it.'},
    ]},
  ],
  directions:[
    {id:'rules', title:'Rules that reveal architectural impact', teaser:'Turn architectural intent into rules you can apply and investigate.', text:'Build on explicit expectations with custom and architectural rules that can be applied to a codebase. Explore where a rule reaches, what it affects, and the evidence behind its findings.', items:['Custom rules applied to code','Affected components and relationships','Deeper evidence-backed audits']},
    {id:'ide', title:'From investigation to editing', teaser:'Bring source editing and saving into the investigation.', text:'Extend the workspace so you can move from a question and its evidence to editing source directly, then save to the durable destination selected for that working graph.', items:['Edit source in the workspace','Save to the selected destination','Keep graph state and source currentness clear']},
    {id:'systems', title:'Understanding across repositories', teaser:'Follow relationships beyond the boundaries of one project.', text:'Expand access to authorized repositories beyond a personal GitHub account, and connect understanding across repositories while preserving the identity and provenance of each source.', items:['Additional authorized repositories','Cross-repository relationships','Source identity and provenance']},
    {id:'storage', title:'Intelligence that can move with you', teaser:'Make graph storage, movement, and availability more flexible.', text:'Build on local and connected environments with clearer ways to transfer durable graphs between supported locations and recover access to intelligence across computers and services.', items:['Transfer graphs between locations','Durable storage and recovery','Access across connected environments']},
    {id:'evidence', title:'Source meets the running system', teaser:'Add durable runtime and database evidence to the source picture.', text:'Extend source-level investigation with bounded, durable observations from databases and running environments. Connect those observations to source while retaining when and where the evidence came from.', items:['Database and runtime snapshots','Connect observations to source','Time and provenance in context']},
  ],
};
