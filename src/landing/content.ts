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
    { id:'workspace', label:'02 / THE WORKSPACE', title:'An environment for understanding.', text:'Explore the intelligence around your project from a connected workspace. Move between a question, the graph, source, and evidence while keeping the investigation in view.', capabilities:[
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
    {id:'code', title:'Deeper source understanding', subtitle:'THE FOUNDATION', text:'Grow language and compiler-grounded understanding of code, relationships, conditions, and behavior.', items:['Richer language intelligence','Connected source and evidence','Honest coverage and uncertainty']},
    {id:'rules', title:'Architecture, rules & audits', subtitle:'EXPLORE', text:'Apply architectural and custom expectations to code, inspect what they affect, and deepen evidence-backed auditing.', items:['Custom and architectural rules','Evidence-backed audits','Change and affected areas']},
    {id:'ide', title:'A connected working environment', subtitle:'EXPLORE', text:'Develop an IDE-like workspace that brings questions, graph, source, and evidence together—and explore authorized source editing and saving.', items:['Graph and query workspace','Source editing and durable saves','Currentness and investigation context']},
    {id:'systems', title:'Projects across boundaries', subtitle:'EXPLORE', text:'Broaden access to authorized repositories and explore how intelligence can connect across projects and systems.', items:['Repositories beyond a personal account','Cross-repository relationships','Source identity and provenance']},
    {id:'storage', title:'Computers, storage & transfers', subtitle:'EVOLVING', text:'Make source, compute, durable graph storage, availability, and transfer more understandable and connected.', items:['Local and hosted environments','Graph storage and movement','Availability and recovery']},
    {id:'evidence', title:'Runtime & database evidence', subtitle:'EXPLORE', text:'Extend source understanding with durable, bounded observations from databases and running environments, with time and provenance intact.', items:['Environment and database snapshots','Source and observation together','Towards runtime and cross-system context']},
  ],
};
